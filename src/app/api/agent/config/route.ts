import { NextResponse } from "next/server";
import { z } from "zod";

import { withAgent } from "@/lib/agent-auth/route";
import { UPLOAD_CHUNK_SIZE } from "@/lib/services/sync";
import type { AgentConfigResponse } from "@/lib/shared/canonical";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agent/config
 * Central-approved configuration. The agent never receives credentials or
 * anything about other facilities.
 */
export const GET = withAgent(z.object({}).optional(), async ({ agent }) => {
  const config: AgentConfigResponse = {
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
    verifyRequested: agent.verifyRequested,
    // Same instruction as the heartbeat carries. An agent that polls config
    // instead of heartbeating must not be able to miss a pause.
    syncControlState: agent.syncControlState,
    controlRevision: agent.controlRevision,
    pauseReason: agent.pauseReason,
  };
  return NextResponse.json(config);
});
