import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, withAgent } from "@/lib/agent-auth/route";
import { assertPcucodeMatches } from "@/lib/agent-auth/verify";
import { db } from "@/lib/db";
import { syncBatches } from "@/lib/db/schema";
import { ingestUsageRecords, upsertDrugMaster, UPLOAD_CHUNK_SIZE } from "@/lib/services/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const usageRecord = z.object({
  visitNo: z.number().int(),
  drugCode: z.string().min(1).max(24),
  drugName: z.string().max(255).nullable(),
  drugType: z.string().max(2).nullable(),
  quantity: z.number(),
  unit: z.string().max(64).nullable(),
  unitCode: z.string().max(15).nullable().optional().default(null),
  clinic: z.string().max(5).nullable(),
  usageDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const drugRecord = z.object({
  drugCode: z.string().min(1).max(24),
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
  pcucode: z.string().min(1).max(5),
  sourceVersion: z.string().max(40).nullable(),
  drugs: z.array(drugRecord).max(2000).optional(),
  records: z.array(usageRecord).max(UPLOAD_CHUNK_SIZE),
});

/**
 * POST /api/agent/sync/upload
 * Ingests one chunk. Idempotent: re-uploading the same chunk updates the same
 * rows instead of duplicating them. Invalid rows are rejected individually.
 */
export const POST = withAgent(schema, async ({ agent, body }) => {
  assertPcucodeMatches(agent, body.pcucode);

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
