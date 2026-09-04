import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { withAgent } from "@/lib/agent-auth/route";
import { assertPcucodeMatches } from "@/lib/agent-auth/verify";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { UPLOAD_CHUNK_SIZE } from "@/lib/services/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  agentVersion: z.string().max(40),
  hostname: z.string().max(120),
  installationId: z.string().max(64),
  status: z.enum(["ONLINE", "SYNCING", "ERROR"]),
  jhcisConnected: z.boolean(),
  pcucode: z.string().max(5).nullable(),
  mysqlVersion: z.string().max(40).nullable().optional(),
  jhcisVersion: z.string().max(40).nullable().optional(),
  schemaReport: z.record(z.unknown()).nullable().optional(),
  lastError: z.string().max(2000).nullable().optional(),
  pendingBatches: z.number().int().min(0).optional(),
});

/**
 * POST /api/agent/heartbeat
 * Liveness plus the JHCIS compatibility report. Never carries patient data and
 * never carries JHCIS credentials.
 */
export const POST = withAgent(schema, async ({ agent, body }) => {
  // A heartbeat from an agent whose JHCISDB reports a different pcucode means a
  // misconfigured or swapped installation - refuse it loudly.
  if (body.pcucode) assertPcucodeMatches(agent, body.pcucode);

  const now = new Date();
  await db
    .update(agents)
    .set({
      status: body.status,
      version: body.agentVersion,
      hostname: body.hostname,
      installationId: body.installationId,
      lastHeartbeatAt: now,
      jhcisPcucode: body.pcucode ?? agent.expectedPcucode,
      mysqlVersion: body.mysqlVersion ?? null,
      jhcisVersion: body.jhcisVersion ?? null,
      ...(body.schemaReport ? { schemaReport: body.schemaReport } : {}),
      ...(body.lastError ? { lastError: body.lastError, lastErrorAt: now } : {}),
    })
    .where(eq(agents.id, agent.agentId));

  return NextResponse.json({
    ok: true,
    serverTime: now.toISOString(),
    config: {
      facilityId: agent.facilityId,
      facilityCode: agent.facilityCode,
      facilityName: agent.facilityName,
      expectedPcucode: agent.expectedPcucode,
      syncIntervalMinutes: agent.syncIntervalMinutes,
      reprocessDays: agent.reprocessDays,
      lastSyncedVisitDate: agent.lastSyncedVisitDate,
      uploadChunkSize: UPLOAD_CHUNK_SIZE,
      disabled: agent.disabled,
      syncRequested: agent.syncRequested,
    },
  });
});
