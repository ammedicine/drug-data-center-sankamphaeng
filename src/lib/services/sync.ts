/**
 * Sync ingestion (PROJECT_SPEC sections 10-12, JHCIS_INTEGRATION sections 13, 22, 23).
 *
 * Guarantees:
 *  - idempotent: rows are keyed by drugUsageRecordKey and upserted
 *  - partial tolerance: one bad row is rejected, the batch still commits
 *  - facility-bound: facilityId always comes from the authenticated agent
 */
import { assertAgentSyncAllowed } from "@/lib/agent-auth/sync-control";
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { withWriteConflictRetry } from "@/lib/db/retry";
import { isIneligibleSourceRow } from "@/lib/shared/ingest-rules";
import { invalidateUsageReports } from "./report-cache";
import { agents, drugUsage, drugs, syncBatches, syncRejects } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import {
  drugUsageRecordKey,
  type DrugMasterRecord,
  type DrugUsageRecord,
  type SyncUploadResponse,
} from "@/lib/shared/canonical";
import type { AuthenticatedAgent } from "@/lib/agent-auth/verify";

/**
 * Rows per multi-row upsert sent to TiDB.
 *
 * Held equal to UPLOAD_CHUNK_SIZE so one uploaded chunk becomes one statement:
 * measured against the real TiDB Cloud instance, 500 averaged ~565ms per
 * upload request against ~663ms at 200 - the difference being TiDB round trips
 * rather than work, since the row count is identical. 500 rows of drug_usage
 * is roughly 150KB, far inside the packet and transaction limits.
 */
const UPSERT_CHUNK = 500;
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
  // The two conditions that make a source row permanently unstorable are
  // shared with the agent, which counts by them when it compares its months
  // against ours. If they ever disagree, a month that can never match is
  // repaired on every schedule for ever - which is exactly what happened.
  const drugCode = (record.drugCode ?? "").trim();
  const visitNo = Number(record.visitNo);
  if (isIneligibleSourceRow({ drugCode, visitNo })) {
    return {
      ok: false,
      reason: drugCode ? "visit_no ไม่ถูกต้อง" : "drug_code ว่าง",
      recordKey: null,
    };
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
  // Defence in depth. The route checks this too; this is the layer that
  // still holds if a future endpoint reaches the core without asking.
  await assertAgentSyncAllowed(input.agent.agentId);
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
  await assertAgentSyncAllowed(agent.agentId);
  // Same ordering argument as the usage upsert: this table's unique key is
  // (facility_id, drug_code), the facility is fixed for one request, so
  // ascending drug_code is ascending index order. Master uploads land at the
  // same moment as everyone else's, which is when contention happens.
  const rows = records
    .filter((r) => r.drugCode?.trim())
    .sort((a, b) => (a.drugCode.trim() < b.drugCode.trim() ? -1 : 1))
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
    // Keyed by (facility_id, drug_code) and idempotent, so a lost lock race is
    // safe to run again - and the master upload lands at the same moment as
    // everyone else's usage rows, which is when races happen.
    await withWriteConflictRetry(
      {
        statement: "drugs upsert",
        agentId: agent.agentId,
        facilityId: agent.facilityId,
        rows: part.length,
      },
      () =>
        db
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
          }),
    );
  }

  // drug_flag, names and units all show up in the reports, so a refreshed
  // master invalidates them just as new usage rows do.
  if (rows.length) invalidateUsageReports();

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
  await assertAgentSyncAllowed(input.agent.agentId);
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

  // Written in record_key order: the same rows, in the same sequence, every
  // time this chunk is delivered.
  //
  // The agent reads JHCIS by (visitdate, visitno, drugcode) and record_key is
  // a hash, so without this the keys arrive as an arbitrary permutation and a
  // re-sent chunk locks the unique index in a different order than it did the
  // first time. Sorting removes that variable and costs nothing at 500 rows.
  //
  // Measured honestly: it did NOT reduce the deadlock rate on the fifteen-agent
  // harness (15.3% before, 15.8% after - the same within noise). InnoDB named
  // the real contention as insert intention locks on the PRIMARY index, which
  // is ordered by the AUTO_INCREMENT id and so cannot be influenced from here.
  // The ordering stays because determinism is worth having on its own, not
  // because it fixed anything.
  const unique = [...byKey.values()].sort((a, b) => (a.recordKey < b.recordKey ? -1 : 1));

  for (const part of chunk(unique, UPSERT_CHUNK)) {
    // Upserting by record_key is idempotent, so running it a second time after
    // a lock race costs nothing and cannot double count.
    await withWriteConflictRetry(
      {
        statement: "drug_usage upsert",
        agentId: input.agent.agentId,
        facilityId: input.agent.facilityId,
        rows: part.length,
      },
      () =>
        db
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
          }),
    );
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

  // Counters, so not idempotent on their own - but a statement that lost a
  // lock race was rolled back whole, so it applied nothing and running it
  // again adds each amount exactly once.
  await withWriteConflictRetry(
    {
      statement: "sync_batches counters",
      agentId: input.agent.agentId,
      facilityId: input.agent.facilityId,
      rows: input.records.length,
    },
    () =>
      db
        .update(syncBatches)
        .set({
          status: "UPLOADING",
          recordsSent: sql`${syncBatches.recordsSent} + ${input.records.length}`,
          recordsAccepted: sql`${syncBatches.recordsAccepted} + ${unique.length}`,
          recordsRejected: sql`${syncBatches.recordsRejected} + ${rejects.length}`,
        })
        .where(eq(syncBatches.id, input.batchId)),
  );

  // The reports are cached until new rows land. They just did.
  if (unique.length) invalidateUsageReports();

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
  await assertAgentSyncAllowed(input.agent.agentId);
  const [batch] = await db
    .select({ rangeFrom: syncBatches.rangeFrom, rangeTo: syncBatches.rangeTo })
    .from(syncBatches)
    .where(eq(syncBatches.id, input.batchId))
    .limit(1);
  const servedRequest = Boolean(
    input.agent.syncRequestedFrom &&
      batch?.rangeFrom === input.agent.syncRequestedFrom &&
      batch?.rangeTo === input.agent.syncRequestedTo,
  );

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
        // Forward only. A manual back-fill of an old period reports an older
        // last visit date than the watermark already holds, and writing it
        // straight in would tell the agent it has nothing since - so every
        // request to re-read one week in July would drag the whole autumn back
        // through the pipe. Purging is the only thing that moves this
        // backwards, and it does so deliberately.
        ...(input.lastVisitDate
          ? {
              lastSyncedVisitDate: sql`GREATEST(COALESCE(${agents.lastSyncedVisitDate}, '1900-01-01'), ${input.lastVisitDate})`,
            }
          : {}),
        // Clear the requested window only when this batch is the one that read
        // it. Clearing on any successful sync let an unrelated run - the one
        // the agent starts the moment it launches - throw away a request that
        // had not been carried out yet.
        ...(servedRequest ? { syncRequestedFrom: null, syncRequestedTo: null } : {}),
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

/* ------------------------------------------------------- clearing data */

export interface PurgeRequest {
  facilityId: string;
  /** null = every service date on record */
  from: string | null;
  to: string | null;
}

export interface PurgeResult {
  deletedRows: number;
  /** what the agent will re-read from on its next run, null = everything */
  watermarkResetTo: string | null;
}

/** Rows that a purge would remove, so the operator sees the size first. */
export async function countFacilityUsage(request: PurgeRequest): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(drugUsage)
    .where(purgeWhere(request));
  return Number(row?.total ?? 0);
}

function purgeWhere(request: PurgeRequest): SQL {
  const parts: SQL[] = [eq(drugUsage.facilityId, request.facilityId)];
  if (request.from) parts.push(gte(drugUsage.usageDate, request.from));
  if (request.to) parts.push(lte(drugUsage.usageDate, request.to));
  return and(...parts) as SQL;
}

/**
 * Deletes dispensing records for one สถานบริการ, optionally limited to a range
 * of service dates.
 *
 * The agent's watermark has to move with the data. It records the latest
 * visit_date already ingested and an incremental run starts from there, so
 * deleting rows without touching it leaves a hole that no future sync will
 * ever fill - the agent believes that window is done. After a purge the
 * watermark is pulled back to just before the deleted range (or cleared
 * entirely, which makes the next run a full re-read), so the data can be
 * brought back simply by syncing again.
 *
 * Batch history and the drug master are deliberately left alone: the first is
 * the record of what happened, and the second is shared reference data whose
 * loss would cost every remaining row its category, unit and status.
 */
export async function purgeFacilityUsage(request: PurgeRequest): Promise<PurgeResult> {
  // drizzle-mysql2 hands back [ResultSetHeader, fields]; affectedRows lives on
  // the header, not on the array. Reading it off the array gave 0 every time,
  // which would have reported "ล้างแล้ว 0 รายการ" after deleting hundreds.
  const deleted = (await db.delete(drugUsage).where(purgeWhere(request))) as unknown as [
    { affectedRows?: number } | undefined,
  ];
  const deletedRows = Number(deleted?.[0]?.affectedRows ?? 0);

  // Re-reading one day either side of the boundary is cheap and removes any
  // argument about whether the endpoint itself was included.
  const watermark = request.from ? previousDay(request.from) : null;

  const agentRows = await db
    .select({ id: agents.id, lastSyncedVisitDate: agents.lastSyncedVisitDate })
    .from(agents)
    .where(eq(agents.facilityId, request.facilityId));

  for (const agent of agentRows) {
    // Only ever move the watermark backwards.
    if (watermark && agent.lastSyncedVisitDate && agent.lastSyncedVisitDate <= watermark) continue;
    await db
      .update(agents)
      .set({ lastSyncedVisitDate: watermark })
      .where(eq(agents.id, agent.id));
  }

  invalidateUsageReports();
  return { deletedRows, watermarkResetTo: watermark };
}

function previousDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}
