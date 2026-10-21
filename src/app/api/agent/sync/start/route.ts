import { NextResponse } from "next/server";
import { z } from "zod";

import { withAgent } from "@/lib/agent-auth/route";
import { assertAgentSyncAllowed } from "@/lib/agent-auth/sync-control";
import { assertPcucodeMatches } from "@/lib/agent-auth/verify";
import { writeAudit } from "@/lib/services/audit";
import { assertCurrentGlobalSyncStartDateRangeAllowed } from "@/lib/services/global-sync-enforcement";
import { startBatch, UPLOAD_CHUNK_SIZE } from "@/lib/services/sync";
import { globalSyncBackfillService } from "@/lib/services/global-sync-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const historicalBackfillSchema = z.object({
  requestId: z.string().min(1).max(30),
  policyRevision: z.number().int().min(1),
  from: isoDate,
  to: isoDate,
  batchRef: z.string().min(5).max(40),
});

const schema = z.object({
  batchRef: z.string().min(5).max(40),
  mode: z.enum(["INITIAL", "INCREMENTAL", "MANUAL_RANGE", "RETRY"]),
  rangeFrom: isoDate.nullable(),
  rangeTo: isoDate.nullable(),
  pcucode: z.string().min(1).max(5),
  recordsRead: z.number().int().min(0).default(0),
  historicalBackfill: historicalBackfillSchema.optional(),
});

/**
 * POST /api/agent/sync/start
 * Opens (or resumes) a sync batch. Re-calling with the same batchRef is safe -
 * the agent may retry after a network failure.
 */
export const POST = withAgent(schema, async ({ agent, body }) => {
  // Before anything is opened: the centre decides whether it is taking
  // this agent's data at all, and it decides that here rather than
  // trusting the agent to have stopped asking.
  if (!body.historicalBackfill) await assertAgentSyncAllowed(agent.agentId);
  assertPcucodeMatches(agent, body.pcucode);
  await assertCurrentGlobalSyncStartDateRangeAllowed({
    rangeFrom: body.rangeFrom,
    rangeTo: body.rangeTo,
  });

  const historical = body.historicalBackfill;
  if (
    historical &&
    (body.mode !== "MANUAL_RANGE" ||
      historical.batchRef !== body.batchRef ||
      historical.from !== body.rangeFrom ||
      historical.to !== body.rangeTo)
  ) throw new Error("Historical backfill context must match the MANUAL_RANGE request");
  const { batchId, resumed } = historical
    ? await globalSyncBackfillService.start({
        agent,
        requestId: historical.requestId,
        policyRevision: historical.policyRevision,
        from: historical.from,
        to: historical.to,
        batchRef: historical.batchRef,
        recordsRead: body.recordsRead,
      })
    : await startBatch({
        agent,
        batchRef: body.batchRef,
        mode: body.mode,
        rangeFrom: body.rangeFrom,
        rangeTo: body.rangeTo,
        recordsRead: body.recordsRead,
      });

  if (!resumed && !historical) {
    await writeAudit({
      actorType: "AGENT",
      actorId: agent.agentId,
      actorLabel: agent.agentName,
      action: "SYNC_START",
      resource: "sync_batch",
      resourceId: batchId,
      facilityId: agent.facilityId,
      metadata: { batchRef: body.batchRef, mode: body.mode, from: body.rangeFrom, to: body.rangeTo },
    });
  }

  return NextResponse.json({ batchId, resumed, uploadChunkSize: UPLOAD_CHUNK_SIZE });
});
