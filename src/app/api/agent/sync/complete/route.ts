import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, withAgent } from "@/lib/agent-auth/route";
import { db } from "@/lib/db";
import { syncBatches } from "@/lib/db/schema";
import { writeAudit } from "@/lib/services/audit";
import { completeBatch } from "@/lib/services/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  batchRef: z.string().min(5).max(40),
  status: z.enum(["COMPLETED", "FAILED", "ABORTED"]),
  recordsRead: z.number().int().min(0),
  recordsSent: z.number().int().min(0),
  lastVisitDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  errorMessage: z.string().max(2000).nullable().optional(),
});

/**
 * POST /api/agent/sync/complete
 * Closes the batch and, on success, advances the incremental watermark that the
 * agent will resume from.
 */
export const POST = withAgent(schema, async ({ agent, body }) => {
  const [batch] = await db
    .select({ id: syncBatches.id, status: syncBatches.status })
    .from(syncBatches)
    .where(and(eq(syncBatches.agentId, agent.agentId), eq(syncBatches.batchRef, body.batchRef)))
    .limit(1);

  if (!batch) return apiError(404, "BATCH_NOT_FOUND", "Sync batch was not started");

  await completeBatch({
    agent,
    batchId: batch.id,
    status: body.status,
    recordsRead: body.recordsRead,
    recordsSent: body.recordsSent,
    lastVisitDate: body.lastVisitDate,
    errorMessage: body.errorMessage ?? null,
  });

  await writeAudit({
    actorType: "AGENT",
    actorId: agent.agentId,
    actorLabel: agent.agentName,
    action: body.status === "COMPLETED" ? "SYNC_COMPLETE" : "SYNC_FAILED",
    resource: "sync_batch",
    resourceId: batch.id,
    facilityId: agent.facilityId,
    metadata: {
      batchRef: body.batchRef,
      recordsRead: body.recordsRead,
      recordsSent: body.recordsSent,
      lastVisitDate: body.lastVisitDate,
    },
  });

  return NextResponse.json({ ok: true });
});
