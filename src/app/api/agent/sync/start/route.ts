import { NextResponse } from "next/server";
import { z } from "zod";

import { withAgent } from "@/lib/agent-auth/route";
import { assertPcucodeMatches } from "@/lib/agent-auth/verify";
import { writeAudit } from "@/lib/services/audit";
import { startBatch, UPLOAD_CHUNK_SIZE } from "@/lib/services/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const schema = z.object({
  batchRef: z.string().min(5).max(40),
  mode: z.enum(["INITIAL", "INCREMENTAL", "MANUAL_RANGE", "RETRY"]),
  rangeFrom: isoDate.nullable(),
  rangeTo: isoDate.nullable(),
  pcucode: z.string().min(1).max(5),
  recordsRead: z.number().int().min(0).default(0),
});

/**
 * POST /api/agent/sync/start
 * Opens (or resumes) a sync batch. Re-calling with the same batchRef is safe -
 * the agent may retry after a network failure.
 */
export const POST = withAgent(schema, async ({ agent, body }) => {
  assertPcucodeMatches(agent, body.pcucode);

  const { batchId, resumed } = await startBatch({
    agent,
    batchRef: body.batchRef,
    mode: body.mode,
    rangeFrom: body.rangeFrom,
    rangeTo: body.rangeTo,
    recordsRead: body.recordsRead,
  });

  if (!resumed) {
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
