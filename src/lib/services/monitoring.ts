/**
 * Agent / sync monitoring queries (PROJECT_SPEC sections 8, 18, 30).
 * Facility scope is always supplied by the caller after resolveFacilityScope().
 */
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, facilities, syncBatches } from "@/lib/db/schema";
import type { AgentStatus } from "@/lib/db/schema";

/** An agent is considered offline when its heartbeat is older than this. */
export const HEARTBEAT_TIMEOUT_MINUTES = 10;

export interface AgentRow {
  id: string;
  name: string;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  status: AgentStatus;
  effectiveStatus: AgentStatus;
  version: string | null;
  hostname: string | null;
  jhcisVersion: string | null;
  lastHeartbeatAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  syncCount: number;
  failedCount: number;
  enrolledAt: Date | null;
  lastSyncedVisitDate: string | null;
}

/** Heartbeat age decides ONLINE vs OFFLINE; the stored status is a hint only. */
export function effectiveStatus(row: {
  status: AgentStatus;
  lastHeartbeatAt: Date | null;
}): AgentStatus {
  if (row.status === "DISABLED") return "DISABLED";
  if (!row.lastHeartbeatAt) return "OFFLINE";
  const ageMinutes = (Date.now() - row.lastHeartbeatAt.getTime()) / 60_000;
  if (ageMinutes > HEARTBEAT_TIMEOUT_MINUTES) return "OFFLINE";
  return row.status === "OFFLINE" ? "ONLINE" : row.status;
}

export async function listAgents(facilityIds: string[] | null): Promise<AgentRow[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      facilityId: agents.facilityId,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      status: agents.status,
      version: agents.version,
      hostname: agents.hostname,
      jhcisVersion: agents.jhcisVersion,
      lastHeartbeatAt: agents.lastHeartbeatAt,
      lastSuccessfulSyncAt: agents.lastSuccessfulSyncAt,
      lastError: agents.lastError,
      lastErrorAt: agents.lastErrorAt,
      syncCount: agents.syncCount,
      failedCount: agents.failedCount,
      enrolledAt: agents.enrolledAt,
      lastSyncedVisitDate: agents.lastSyncedVisitDate,
    })
    .from(agents)
    .innerJoin(facilities, eq(facilities.id, agents.facilityId))
    .where(facilityIds ? inArray(agents.facilityId, facilityIds) : undefined)
    .orderBy(desc(agents.lastHeartbeatAt));

  return rows.map((r) => ({
    ...r,
    lastSyncedVisitDate: r.lastSyncedVisitDate ? String(r.lastSyncedVisitDate) : null,
    effectiveStatus: effectiveStatus(r),
  }));
}

export interface SyncBatchRow {
  id: string;
  batchRef: string;
  facilityCode: string;
  facilityName: string;
  agentName: string;
  mode: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  recordsRead: number;
  recordsAccepted: number;
  recordsRejected: number;
  errorMessage: string | null;
}

export async function listSyncBatches(
  facilityIds: string[] | null,
  limit = 50,
  onlyFailed = false,
): Promise<SyncBatchRow[]> {
  const parts: SQL[] = [];
  if (facilityIds) parts.push(inArray(syncBatches.facilityId, facilityIds));
  if (onlyFailed) parts.push(eq(syncBatches.status, "FAILED"));

  return db
    .select({
      id: syncBatches.id,
      batchRef: syncBatches.batchRef,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      agentName: agents.name,
      mode: syncBatches.mode,
      status: syncBatches.status,
      startedAt: syncBatches.startedAt,
      completedAt: syncBatches.completedAt,
      recordsRead: syncBatches.recordsRead,
      recordsAccepted: syncBatches.recordsAccepted,
      recordsRejected: syncBatches.recordsRejected,
      errorMessage: syncBatches.errorMessage,
    })
    .from(syncBatches)
    .innerJoin(facilities, eq(facilities.id, syncBatches.facilityId))
    .innerJoin(agents, eq(agents.id, syncBatches.agentId))
    .where(parts.length ? (and(...parts) as SQL) : undefined)
    .orderBy(desc(syncBatches.startedAt))
    .limit(limit);
}

export interface FleetSummary {
  facilities: number;
  agentsTotal: number;
  online: number;
  offline: number;
  errored: number;
  failedBatches24h: number;
  lastSyncAt: Date | null;
}

export async function getFleetSummary(facilityIds: string[] | null): Promise<FleetSummary> {
  const agentRows = await listAgents(facilityIds);

  const [facilityCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(facilities)
    .where(facilityIds ? inArray(facilities.id, facilityIds) : eq(facilities.isActive, true));

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const failedParts: SQL[] = [
    eq(syncBatches.status, "FAILED"),
    sql`${syncBatches.startedAt} >= ${since}`,
  ];
  if (facilityIds) failedParts.push(inArray(syncBatches.facilityId, facilityIds));

  const [failed] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(syncBatches)
    .where(and(...failedParts));

  const [lastSync] = await db
    .select({ at: sql<Date | null>`MAX(${agents.lastSuccessfulSyncAt})` })
    .from(agents)
    .where(
      facilityIds
        ? and(inArray(agents.facilityId, facilityIds), isNotNull(agents.lastSuccessfulSyncAt))
        : isNotNull(agents.lastSuccessfulSyncAt),
    );

  return {
    facilities: Number(facilityCount?.n ?? 0),
    agentsTotal: agentRows.length,
    online: agentRows.filter((a) => a.effectiveStatus === "ONLINE" || a.effectiveStatus === "SYNCING")
      .length,
    offline: agentRows.filter((a) => a.effectiveStatus === "OFFLINE").length,
    errored: agentRows.filter((a) => a.effectiveStatus === "ERROR").length,
    failedBatches24h: Number(failed?.n ?? 0),
    lastSyncAt: lastSync?.at ? new Date(lastSync.at) : null,
  };
}
