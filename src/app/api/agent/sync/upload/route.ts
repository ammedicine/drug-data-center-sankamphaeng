import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, withAgent } from "@/lib/agent-auth/route";
import {
  assertAgentSyncAllowed,
  assertAgentSyncAllowedForBatch,
} from "@/lib/agent-auth/sync-control";
import { assertPcucodeMatches } from "@/lib/agent-auth/verify";
import { db } from "@/lib/db";
import { syncBatches } from "@/lib/db/schema";
import { assertCurrentGlobalSyncStartDateRecordsAllowed } from "@/lib/services/global-sync-enforcement";
import { resolveUploadChunkIdentity } from "@/lib/services/idempotent-upload-chunk";
import {
  ingestIdempotentUsageChunk,
  ingestUsageRecords,
  upsertDrugMaster,
  UPLOAD_CHUNK_SIZE,
} from "@/lib/services/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deliberately permissive: the row-level rules live in ingestUsageRecords so a
 * single malformed row is rejected on its own with a reason an operator can
 * read. Enforcing them here would fail the whole 500-row request instead - JHCIS
 * really does contain rows with an empty drugcode, and one of them must not
 * take 499 good rows down with it (JHCIS_INTEGRATION section 23).
 */
const usageRecord = z.object({
  visitNo: z.number().int(),
  drugCode: z.string().max(24),
  drugName: z.string().max(255).nullable(),
  drugType: z.string().max(2).nullable(),
  quantity: z.number(),
  unit: z.string().max(64).nullable(),
  unitCode: z.string().max(15).nullable().optional().default(null),
  clinic: z.string().max(5).nullable(),
  visitMissing: z.boolean().optional().default(false),
  usageDate: z.string().max(10),
});

const drugRecord = z.object({
  drugCode: z.string().max(24),
  drugName: z.string().max(255),
  genericName: z.string().max(220).nullable(),
  drugType: z.string().max(2).nullable(),
  drugTypeSub: z.string().max(2).nullable(),
  drugFlag: z.string().max(1).nullable(),
  unitSell: z.string().max(15).nullable(),
  unitSellName: z.string().max(64).nullable().optional().default(null),
  unitUsage: z.string().max(15).nullable(),
  unitUsageName: z.string().max(64).nullable().optional().default(null),
});

const schema = z.object({
  batchRef: z.string().min(5).max(40),
  chunkRef: z.string().min(1).max(100).optional(),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  pcucode: z.string().min(1).max(5),
  sourceVersion: z.string().max(40).nullable(),
  drugs: z.array(drugRecord).max(2000).optional(),
  records: z.array(usageRecord).max(UPLOAD_CHUNK_SIZE),
});

/**
 * POST /api/agent/sync/upload
 * Ingests one chunk. Receipt-capable Agents get chunk-processing idempotency;
 * legacy Agents retain record_key fact-row idempotency. Invalid rows are
 * rejected individually.
 */
export const POST = withAgent(schema, async ({ agent, body }) => {
  assertPcucodeMatches(agent, body.pcucode);
  const identity = resolveUploadChunkIdentity(body);

  if (identity) {
    await assertAgentSyncAllowedForBatch(agent.agentId, body.batchRef);
    const result = await ingestIdempotentUsageChunk({
      agent,
      batchRef: body.batchRef,
      chunkRef: identity.chunkRef,
      payloadSha256: identity.payloadSha256,
      pcucode: body.pcucode,
      sourceVersion: body.sourceVersion,
      drugs: body.drugs,
      records: body.records,
    });
    return NextResponse.json(result);
  }

  await assertAgentSyncAllowed(agent.agentId);
  await assertCurrentGlobalSyncStartDateRecordsAllowed(body.records);

  const [batch] = await db
    .select({ id: syncBatches.id, status: syncBatches.status })
    .from(syncBatches)
    .where(and(eq(syncBatches.agentId, agent.agentId), eq(syncBatches.batchRef, body.batchRef)))
    .limit(1);

  if (!batch) return apiError(404, "BATCH_NOT_FOUND", "Sync batch was not started");
  if (batch.status === "COMPLETED") {
    return apiError(409, "BATCH_CLOSED", "Sync batch is already completed");
  }

  if (body.drugs?.length) {
    await upsertDrugMaster(agent, body.drugs, body.sourceVersion);
  }

  const result = await ingestUsageRecords({
    agent,
    batchId: batch.id,
    pcucode: body.pcucode,
    sourceVersion: body.sourceVersion,
    records: body.records,
  });

  return NextResponse.json(result);
});
