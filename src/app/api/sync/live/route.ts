/**
 * Status for the pages that refresh themselves.
 *
 * /sync and /admin/monitoring are server-rendered, so until now they only told
 * the truth at the moment they were loaded. This is what they poll instead of
 * reloading: the same data, through the same authorization, small enough to
 * ask for every few seconds.
 *
 * Authorization is not relaxed for being a polling endpoint. requireApiUser
 * re-checks the session against the database, resolveFacilityScope decides
 * which facilities may be read, and neither is influenced by anything the
 * caller sends. Nothing here returns a credential, a signing secret or a JHCIS
 * connection detail - only whether the links are up and how far a run has got.
 */
import { NextResponse } from "next/server";

import {
  ForbiddenError,
  UnauthorizedError,
  requireApiUser,
  resolveFacilityScope,
} from "@/lib/auth/rbac";
import {
  getFleetSummary,
  listAgents,
  listRunningBatches,
} from "@/lib/services/monitoring";
import { LIVE_POLL_SECONDS } from "@/lib/shared/agent-status";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireApiUser();
    const scope = resolveFacilityScope(user);
    // Same rule as the page: a USER sees the machines they enrolled, an
    // administrator sees the สถานบริการ they are responsible for.
    const ownAgentsOnly = user.role === "USER" ? user.userId : null;

    const [agents, running, fleet] = await Promise.all([
      listAgents(scope.facilityIds, ownAgentsOnly),
      listRunningBatches(scope.facilityIds),
      getFleetSummary(scope.facilityIds),
    ]);

    return NextResponse.json(
      {
        serverTime: new Date().toISOString(),
        pollSeconds: LIVE_POLL_SECONDS,
        fleet,
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          facilityCode: agent.facilityCode,
          facilityName: agent.facilityName,
          status: agent.effectiveStatus,
          jhcisState: agent.jhcisState,
          version: agent.version,
          hostname: agent.hostname,
          ipAddress: agent.ipAddress,
          macAddress: agent.macAddress,
          networkInterface: agent.networkInterface,
          lastHeartbeatAt: agent.lastHeartbeatAt,
          lastJhcisCheckAt: agent.lastJhcisCheckAt,
          lastSuccessfulSyncAt: agent.lastSuccessfulSyncAt,
          lastSyncedVisitDate: agent.lastSyncedVisitDate,
          pendingBatches: agent.pendingBatches,
          lastError: agent.lastError,
          ownerName: agent.ownerName,
        })),
        running: running.map((batch) => ({
          agentId: batch.agentId,
          agentName: batch.agentName,
          facilityCode: batch.facilityCode,
          batchRef: batch.batchRef,
          rangeFrom: batch.rangeFrom,
          rangeTo: batch.rangeTo,
          recordsRead: batch.recordsRead,
          recordsAccepted: batch.recordsAccepted,
          recordsRejected: batch.recordsRejected,
          progress: batch.progress,
          ownerName: batch.ownerName,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
