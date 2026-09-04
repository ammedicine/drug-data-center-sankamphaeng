import { NextResponse } from "next/server";
import { z } from "zod";

import { redeemEnrollmentToken } from "@/lib/agent-auth/enrollment";
import { withUnsignedAgent } from "@/lib/agent-auth/route";
import { clientIp, writeAudit } from "@/lib/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(10).max(120),
  hostname: z.string().min(1).max(120),
  installationId: z.string().min(8).max(64),
  agentVersion: z.string().min(1).max(40),
  /** read by the agent from office.offid; validated against the facility */
  pcucode: z.string().max(5).nullable().optional(),
});

/**
 * POST /api/agent/enroll
 * Exchanges a one-time enrollment token for a permanent per-agent credential.
 * This is the only unsigned agent endpoint.
 */
export const POST = withUnsignedAgent(schema, async ({ body, req }) => {
  const result = await redeemEnrollmentToken({
    token: body.token,
    hostname: body.hostname,
    installationId: body.installationId,
    agentVersion: body.agentVersion,
    pcucode: body.pcucode ?? null,
  });

  await writeAudit({
    actorType: "AGENT",
    actorId: result.agentId,
    actorLabel: body.hostname,
    action: "AGENT_ENROLL",
    resource: "agent",
    resourceId: result.agentId,
    facilityId: result.facilityId,
    ip: clientIp(req.headers),
    metadata: { keyId: result.keyId, agentVersion: body.agentVersion },
  });

  // The secret is returned exactly once and never logged.
  return NextResponse.json({
    agentId: result.agentId,
    keyId: result.keyId,
    secret: result.secret,
    facility: {
      id: result.facilityId,
      code: result.facilityCode,
      name: result.facilityName,
      pcucode: result.expectedPcucode,
    },
    syncIntervalMinutes: result.syncIntervalMinutes,
    reprocessDays: result.reprocessDays,
  });
});
