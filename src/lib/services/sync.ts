/**
 * Sync ingestion (PROJECT_SPEC sections 10-12, JHCIS_INTEGRATION sections 13, 22, 23).
 *
 * Guarantees:
 *  - idempotent: rows are keyed by drugUsageRecordKey and upserted
 *  - partial tolerance: one bad row is rejected, the batch still commits
 *  - facility-bound: facilityId always comes from the authenticated agent
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, drugUsage, drugs, syncBatches, syncRejects } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import {
  drugUsageRecordKey,
  type DrugMasterRecord,
  type DrugUsageRecord,
  type SyncUploadResponse,
} from "@/lib/shared/canonical";
import type { AuthenticatedAgent } from "@/lib/agent-auth/verify";

/** Chunk size for the multi-row upserts sent to TiDB. */
const UPSERT_CHUNK = 200;
/** Sanity bound: JHCIS visitdrug.unit is an int; anything wilder is bad data. */
const MAX_QUANTITY = 1_000_000;

export const UPLOAD_CHUNK_SIZE = 500;

interface ValidatedRecord {
  recordKey: string;
  facilityId: string;
  drugCode: string;
  drugNameSnapshot: string | null;
  drugType: string | null;
  visitNo: number;
  usageDate: string;
  quantity: string;
  unit: string | null;
  unitCode: string | null;
  clinic: string | null;
  visitMissing: boolean;
  sourcePcucode: string;
  sourceVersion: string | null;
  syncBatchId: string;
  agentId: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(
  record: DrugUsageRecord,
  ctx: { agent: AuthenticatedAgent; batchId: string; pcucode: string; sourceVersion: string | null },
): { ok: true; value: ValidatedRecord } | { ok: false; reason: string; recordKey: string | null } {
  const drugCode = (record.drugCode ?? "").trim();
  if (!drugCode) return { ok: false, reason: "drug_code ว่าง", recordKey: null };

  const visitNo = Number(record.visitNo);
  if (!Number.isInteger(visitNo) || visitNo <= 0) {
    return { ok: false, reason: "visit_no ไม่ถูกต้อง", recordKey: null };
  }

  const recordKey = drugUsageRecordKey({
    facilityId: ctx.agent.facilityId,
    pcucode: ctx.pcucode,
    visitNo,
    drugCode,
  });

  if (!ISO_DATE.test(record.usageDate ?? "")) {
    return { ok: false, reason: "usage_date ไม่ใช่รูปแบบ YYYY-MM-DD", recordKey };
  }
  const parsed = new Date(`${record.usageDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: "usage_date ไม่ใช่วันที่ที่ถูกต้อง", recordKey };
  }
  if (parsed.getTime() > Date.now() + 86_400_000) {
    return { ok: false, reason: "usage_date เป็นวันที่ในอนาคต", recordKey };
  }

  const quantity = Number(record.quantity);
  if (!Number.isFinite(quantity)) {
    return { ok: false, reason: "quantity ไม่ใช่ตัวเลข", recordKey };
  }
  if (quantity < 0 || quantity > MAX_QUANTITY) {
    return { ok: false, reason: `quantity ผิดปกติ (${quantity})`, recordKey };
  }

  return {
    ok: true,
    value: {
      recordKey,
      facilityId: ctx.agent.facilityId,
      drugCode: drugCode.slice(0, 24),
      drugNameSnapshot: record.drugName?.trim().slice(0, 255) ?? null,
      drugType: record.drugType?.trim().slice(0, 2) ?? null,
      visitNo,
      usageDate: record.usageDate,
      quantity: quantity.toFixed(2),
      unit: record.unit?.trim().slice(0, 64) ?? null,
      unitCode: record.unitCode?.trim().slice(0, 15) ?? null,
      clinic: record.clinic?.trim().slice(0, 5) ?? null,
      visitMissing: record.visitMissing === true,
      sourcePcucode: ctx.pcucode,
      sourceVersion: ctx.sourceVersion,
      syncBatchId: ctx.batchId,
      agentId: ctx.agent.agentId,
    },
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Finds an existing batch for this agent, or creates it (start is idempotent). */
export async function startBatch(input: {
  agent: AuthenticatedAgent;
  batchRef: string;
  mode: "INITIAL" | "INCREMENTAL" | "MANUAL_RANGE" | "RETRY";
  rangeFrom: string | null;
  rangeTo: string | null;
  recordsRead: number;
}): Promise<{ batchId: string; resumed: boolean }> {
  const existing = await db
    .select({ id: syncBatches.id, status: syncBatches.status })
    .from(syncBatches)
    .where(
      and(eq(syncBatches.agentId, input.agent.agentId), eq(syncBatches.batchRef, input.batchRef)),
    )
    .limit(1);

  if (existing[0]) return { batchId: existing[0].id, resumed: true };

  const batchId = newId();
  await db.insert(syncBatches).values({
    id: batchId,
    batchRef: input.batchRef,
    agentId: input.agent.agentId,
    facilityId: input.agent.facilityId,
    mode: input.mode,
    status: "STARTED",
    rangeFrom: input.rangeFrom,
    rangeTo: input.rangeTo,
    startedAt: new Date(),
    recordsRead: input.recordsRead,
  });

  await db
    .update(agents)
    .set({ status: "SYNCING", lastSyncAt: new Date() })
    .where(eq(agents.id, input.agent.agentId));

  return { batchId, resumed: false };
}

/** Upserts drug master rows for the facility (names are versioned by usage rows). */
export async function upsertDrugMaster(
  agent: AuthenticatedAgent,
  records: DrugMasterRecord[],
  sourceVersion: string | null,
): Promise<number> {
  const rows = records
    .filter((r) => r.drugCode?.trim())
    .map((r) => ({
      facilityId: agent.facilityId,
      drugCode: r.drugCode.trim().slice(0, 24),
      drugName: (r.drugName ?? r.drugCode).trim().slice(0, 255),
      genericName: r.genericName?.trim().slice(0, 220) ?? null,
      drugType: r.drugType?.trim().slice(0, 2) ?? null,
      drugTypeSub: r.drugTypeSub?.trim().slice(0, 2) ?? null,
      drugFlag: r.drugFlag?.trim().slice(0, 1) ?? null,
      unitSell: r.unitSell?.trim().slice(0, 15) ?? null,
      unitSellName: r.unitSellName?.trim().slice(0, 64) ?? null,
      unitUsage: r.unitUsage?.trim().slice(0, 15) ?? null,
      unitUsageName: r.unitUsageName?.trim().slice(0, 64) ?? null,
      sourceVersion,
      syncedAt: new Date(),
    }));

  for (const part of chunk(rows, UPSERT_CHUNK)) {
    await db
      .insert(drugs)
      .values(part)
      .onDuplicateKeyUpdate({
        set: {
          drugName: sql`VALUES(drug_name)`,
          genericName: sql`VALUES(generic_name)`,
          drugType: sql`VALUES(drug_type)`,
          drugTypeSub: sql`VALUES(drug_type_sub)`,
          drugFlag: sql`VALUES(drug_flag)`,
          unitSell: sql`VALUES(unit_sell)`,
          unitSellName: sql`VALUES(unit_sell_name)`,
          unitUsage: sql`VALUES(unit_usage)`,
          unitUsageName: sql`VALUES(unit_usage_name)`,
          sourceVersion: sql`VALUES(source_version)`,
          syncedAt: sql`VALUES(synced_at)`,
        },
      });
  }
  return rows.length;
}

/** Validates and upserts a chunk of usage rows. Never throws on bad rows. */
export async function ingestUsageRecords(input: {
  agent: AuthenticatedAgent;
  batchId: string;
  pcucode: string;
  sourceVersion: string | null;
  records: DrugUsageRecord[];
}): Promise<SyncUploadResponse> {
  const valid: ValidatedRecord[] = [];
  const rejects: Array<{ recordKey: string | null; reason: string }> = [];

  for (const record of input.records) {
    const result = validate(record, {
      agent: input.agent,
      batchId: input.batchId,
      pcucode: input.pcucode,
      sourceVersion: input.sourceVersion,
    });
    if (result.ok) valid.push(result.value);
    else rejects.push({ recordKey: result.recordKey, reason: result.reason });
  }

  // De-duplicate inside the chunk itself: MySQL cannot upsert the same key twice
  // in one statement deterministically.
  const byKey = new Map<string, ValidatedRecord>();
  for (const row of valid) byKey.set(row.recordKey, row);
  const unique = [...byKey.values()];

  for (const part of chunk(unique, UPSERT_CHUNK)) {
    await db
      .insert(drugUsage)
      .values(part)
      .onDuplicateKeyUpdate({
        set: {
          drugNameSnapshot: sql`VALUES(drug_name_snapshot)`,
          drugType: sql`VALUES(drug_type)`,
          usageDate: sql`VALUES(usage_date)`,
          quantity: sql`VALUES(quantity)`,
          unit: sql`VALUES(unit)`,
          unitCode: sql`VALUES(unit_code)`,
          clinic: sql`VALUES(clinic)`,
          visitMissing: sql`VALUES(visit_missing)`,
          sourceVersion: sql`VALUES(source_version)`,
          syncBatchId: sql`VALUES(sync_batch_id)`,
          agentId: sql`VALUES(agent_id)`,
        },
      });
  }

  if (rejects.length) {
    await db.insert(syncRejects).values(
      rejects.slice(0, 200).map((r) => ({
        batchId: input.batchId,
        facilityId: input.agent.facilityId,
        recordKey: r.recordKey,
        reason: r.reason.slice(0, 255),
      })),
    );
  }

  await db
    .update(syncBatches)
    .set({
      status: "UPLOADING",
      recordsSent: sql`${syncBatches.recordsSent} + ${input.records.length}`,
      recordsAccepted: sql`${syncBatches.recordsAccepted} + ${unique.length}`,
      recordsRejected: sql`${syncBatches.recordsRejected} + ${rejects.length}`,
    })
    .where(eq(syncBatches.id, input.batchId));

  return { accepted: unique.length, rejected: rejects.length, rejects: rejects.slice(0, 50) };
}

/** Closes the batch and advances the agent watermark on success. */
export async function completeBatch(input: {
  agent: AuthenticatedAgent;
  batchId: string;
  status: "COMPLETED" | "FAILED" | "ABORTED";
  recordsRead: number;
  recordsSent: number;
  lastVisitDate: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  await db
    .update(syncBatches)
    .set({
      status: input.status,
      completedAt: new Date(),
      recordsRead: input.recordsRead,
      errorMessage: input.errorMessage?.slice(0, 2000) ?? null,
    })
    .where(eq(syncBatches.id, input.batchId));

  if (input.status === "COMPLETED") {
    await db
      .update(agents)
      .set({
        status: "ONLINE",
        lastSuccessfulSyncAt: new Date(),
        lastSyncAt: new Date(),
        syncCount: sql`${agents.syncCount} + 1`,
        lastError: null,
        ...(input.lastVisitDate ? { lastSyncedVisitDate: input.lastVisitDate } : {}),
      })
      .where(eq(agents.id, input.agent.agentId));
  } else {
    await db
      .update(agents)
      .set({
        status: "ERROR",
        failedCount: sql`${agents.failedCount} + 1`,
        lastError: input.errorMessage?.slice(0, 2000) ?? "Sync failed",
        lastErrorAt: new Date(),
      })
      .where(eq(agents.id, input.agent.agentId));
  }
}
