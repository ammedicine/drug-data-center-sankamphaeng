import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { withAgent } from "@/lib/agent-auth/route";
import { assertPcucodeMatches } from "@/lib/agent-auth/verify";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { UPLOAD_CHUNK_SIZE } from "@/lib/services/sync";
import { parseBuildId, parseCapabilities } from "@/lib/shared/agent-build";

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
  syncRanAt: z.string().datetime().nullable().optional(),

  /* ------------------------------------------ what this build is and can do */
  /**
   * Short source commit. Several v1.1.7 builds all reported the same version
   * and the centre could not tell them apart - including one that destroyed
   * Thai text. Optional, because an older agent sends none of this.
   */
  buildId: z.string().max(40).nullable().optional(),
  capabilities: z.record(z.boolean()).nullable().optional(),
  /** the earliest dispensing date this agent is configured to collect */
  syncStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),

  /* ------------------------------------------- acknowledging control state */
  /** what the agent is actually doing about the centre's instruction */
  effectiveSyncState: z.enum(["RUNNING", "PAUSE_REQUESTED", "PAUSED"]).nullable().optional(),
  /** the highest control revision this agent has acted on */
  appliedControlRevision: z.number().int().min(0).nullable().optional(),

  network: z
    .object({
      macAddress: z.string().max(32).nullable(),
      ipAddress: z.string().max(45).nullable(),
      interfaceName: z.string().max(80).nullable(),
    })
    .nullable()
    .optional(),
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
  // Validated rather than trusted: this string is shown on an operator's
  // screen, and a field the agent controls should never be able to carry
  // markup or anything longer than a commit hash.
  const buildId = parseBuildId(body.buildId);
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
      // The agent reports its own link to JHCIS; Central had been reading this
      // and throwing it away, which left the web unable to say whether a quiet
      // agent was offline or simply unable to reach its database.
      jhcisConnected: body.jhcisConnected,
      lastJhcisCheckAt: now,
      pendingBatches: body.pendingBatches ?? 0,
      // A run that finished, whatever it found. "Sync now" is satisfied by
      // comparing the request against this, and it used to be stamped only
      // when a batch was opened - so a run that found nothing left the
      // request outstanding and every heartbeat started it again.
      ...(body.syncRanAt ? { lastSyncAt: new Date(body.syncRanAt) } : {}),
      // Only overwrite what the agent could actually determine, so a heartbeat
      // sent while the network is confused does not erase a known-good card.
      ...(body.network?.macAddress ? { macAddress: body.network.macAddress } : {}),
      ...(body.network?.ipAddress ? { ipAddress: body.network.ipAddress } : {}),
      ...(body.network?.interfaceName ? { networkInterface: body.network.interfaceName } : {}),
      ...(body.lastError ? { lastError: body.lastError, lastErrorAt: now } : {}),

      // Build identity and capabilities, written only when the agent actually
      // sent them. An older agent must not blank out what a newer one
      // reported before an unlucky downgrade, and "absent" is not "false".
      ...(buildId ? { buildId } : {}),
      ...(body.capabilities ? { capabilities: parseCapabilities(body.capabilities) } : {}),
      ...(body.syncStartDate ? { syncStartDate: body.syncStartDate } : {}),

      // The acknowledgement. This is reporting only - it never decides
      // anything. What the centre will accept is decided by
      // syncControlState, which no agent can write.
      ...(body.effectiveSyncState ? { effectiveSyncState: body.effectiveSyncState } : {}),
      ...(body.appliedControlRevision !== undefined && body.appliedControlRevision !== null
        ? { appliedControlRevision: body.appliedControlRevision, controlAppliedAt: now }
        : {}),
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
      syncRequestedFrom: agent.syncRequestedFrom,
      syncRequestedTo: agent.syncRequestedTo,
      verifyRequested: agent.verifyRequested,
      // The instruction, on the channel the agent already calls on. Nothing
      // reaches into the clinic's LAN; the agent asks, and this is the answer.
      syncControlState: agent.syncControlState,
      controlRevision: agent.controlRevision,
      pauseReason: agent.pauseReason,
    },
  });
});
