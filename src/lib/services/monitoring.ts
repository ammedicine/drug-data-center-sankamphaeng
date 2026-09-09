/**
 * Agent / sync monitoring queries (PROJECT_SPEC sections 8, 18, 30).
 * Facility scope is always supplied by the caller after resolveFacilityScope().
 */
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, facilities, syncBatches, users } from "@/lib/db/schema";
import type { AgentStatus } from "@/lib/db/schema";
import { STALE_AFTER_SECONDS, isFresh, type JhcisLinkState } from "@/lib/shared/agent-status";

/** An agent is considered offline when its heartbeat is older than this. */
/**
 * Kept for anything still importing it. The live threshold is
 * STALE_AFTER_SECONDS in the shared status module, so the agent's heartbeat
 * cadence and the server's idea of "too long ago" cannot drift apart - which
 * they had, at 5 minutes and 10 minutes respectively, guaranteeing the tray
 * and the web disagreed for minutes at a time by design.
 */
export const HEARTBEAT_TIMEOUT_MINUTES = STALE_AFTER_SECONDS / 60;

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
  /** any authenticated request, which is what presence is judged on */
  lastSeenAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  ownerUserId: string | null;
  ownerName: string | null;
  jhcisState: JhcisLinkState;
  lastJhcisCheckAt: Date | null;
  pendingBatches: number;
  macAddress: string | null;
  ipAddress: string | null;
  networkInterface: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  syncCount: number;
  failedCount: number;
  enrolledAt: Date | null;
  lastSyncedVisitDate: string | null;
}

/**
 * When this agent last proved it was alive.
 *
 * Any authenticated request counts, not only the dedicated heartbeat: an agent
 * part-way through a long backfill is sending signed uploads the server keeps
 * accepting, and there is no honest way to call that machine offline. Agents
 * enrolled before this was recorded have no lastSeenAt, so their heartbeat is
 * used and they behave exactly as they did before.
 */
export function lastSeen(row: {
  lastSeenAt?: Date | null;
  lastHeartbeatAt: Date | null;
}): Date | null {
  const seen = row.lastSeenAt ?? null;
  const beat = row.lastHeartbeatAt;
  if (!seen) return beat;
  if (!beat) return seen;
  return seen > beat ? seen : beat;
}

/** Activity age decides ONLINE vs OFFLINE; the stored status is a hint only. */
export function effectiveStatus(row: {
  status: AgentStatus;
  lastSeenAt?: Date | null;
  lastHeartbeatAt: Date | null;
}): AgentStatus {
  if (row.status === "DISABLED") return "DISABLED";
  // Online means it was heard from recently. A stored status of ONLINE from an
  // agent that has since gone quiet is not evidence of anything - and neither
  // is a batch left in RUNNING by an agent that crashed mid-upload, which is
  // why this looks at requests the server actually authenticated.
  if (!isFresh(lastSeen(row))) return "OFFLINE";
  return row.status === "OFFLINE" ? "ONLINE" : row.status;
}

/**
 * What the web can honestly say about an agent's link to its JHCIS database.
 *
 * Only a fresh heartbeat carries a usable answer: an agent that stopped
 * reporting tells us nothing about JHCIS, so the state is UNKNOWN rather than
 * the last thing it happened to say before it went quiet.
 */
export function jhcisLinkState(row: {
  lastHeartbeatAt: Date | null;
  jhcisConnected: boolean | null;
}): JhcisLinkState {
  if (!isFresh(row.lastHeartbeatAt)) return "UNKNOWN";
  if (row.jhcisConnected === null) return "UNKNOWN";
  return row.jhcisConnected ? "CONNECTED" : "UNREACHABLE";
}

/**
 * Agents visible to a caller.
 *
 * `ownerUserId` narrows the list to the machines one account enrolled, which is
 * what a เจ้าหน้าที่ wants: their own PC, not every PC in the district. Pass
 * null to see every agent inside the facility scope - a SUPER_ADMIN watching
 * the whole fleet, or a FACILITY_ADMIN who administers the สถานบริการ.
 */
export async function listAgents(
  facilityIds: string[] | null,
  ownerUserId?: string | null,
): Promise<AgentRow[]> {
  const where: SQL[] = [];
  if (facilityIds) where.push(inArray(agents.facilityId, facilityIds));
  if (ownerUserId) where.push(eq(agents.ownerUserId, ownerUserId));

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
      lastSeenAt: agents.lastSeenAt,
      lastSuccessfulSyncAt: agents.lastSuccessfulSyncAt,
      lastError: agents.lastError,
      lastErrorAt: agents.lastErrorAt,
      syncCount: agents.syncCount,
      failedCount: agents.failedCount,
      enrolledAt: agents.enrolledAt,
      lastSyncedVisitDate: agents.lastSyncedVisitDate,
      ownerUserId: agents.ownerUserId,
      ownerName: users.fullName,
      macAddress: agents.macAddress,
      ipAddress: agents.ipAddress,
      networkInterface: agents.networkInterface,
      jhcisConnected: agents.jhcisConnected,
      lastJhcisCheckAt: agents.lastJhcisCheckAt,
      pendingBatches: agents.pendingBatches,
    })
    .from(agents)
    .innerJoin(facilities, eq(facilities.id, agents.facilityId))
    .leftJoin(users, eq(users.id, agents.ownerUserId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(agents.lastHeartbeatAt));

  return rows.map((r) => ({
    ...r,
    lastSyncedVisitDate: r.lastSyncedVisitDate ? String(r.lastSyncedVisitDate) : null,
    effectiveStatus: effectiveStatus(r),
    jhcisState: jhcisLinkState(r),
  }));
}

export interface SyncBatchRow {
  id: string;
  batchRef: string;
  /** service dates the run read - stored all along, never shown */
  rangeFrom: string | null;
  rangeTo: string | null;
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
      agentName: sql<string>`COALESCE(${agents.name}, 'Agent ที่ถูกลบแล้ว')`,
      mode: syncBatches.mode,
      status: syncBatches.status,
      rangeFrom: syncBatches.rangeFrom,
      rangeTo: syncBatches.rangeTo,
      startedAt: syncBatches.startedAt,
      completedAt: syncBatches.completedAt,
      recordsRead: syncBatches.recordsRead,
      recordsAccepted: syncBatches.recordsAccepted,
      recordsRejected: syncBatches.recordsRejected,
      errorMessage: syncBatches.errorMessage,
    })
    .from(syncBatches)
    .innerJoin(facilities, eq(facilities.id, syncBatches.facilityId))
    // Left, not inner: deleting an agent must not delete the record of what it
    // did. A batch whose agent is gone still belongs in the history.
    .leftJoin(agents, eq(agents.id, syncBatches.agentId))
    .where(parts.length ? (and(...parts) as SQL) : undefined)
    .orderBy(desc(syncBatches.startedAt))
    .limit(limit);
}

export interface RunningBatch {
  agentId: string;
  agentName: string;
  facilityCode: string;
  facilityName: string;
  batchRef: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  startedAt: Date;
  recordsRead: number;
  recordsAccepted: number;
  recordsRejected: number;
  /** 0-1; falls back to 0 when the agent has not reported a total yet */
  progress: number;
  /** the account whose machine is running this, for the "already syncing" notice */
  ownerName: string | null;
}

/** Batches still in flight, for the progress bars on /sync and /admin/monitoring. */
/**
 * Batches actually in flight right now.
 *
 * "In flight" is narrower than "the status column says STARTED": a run whose
 * process died leaves its row that way for ever, and a run that delivered every
 * record it read is finished whether or not anything closed it. Both used to
 * sit on the page as permanent 100% bars, which made the section meaningless -
 * a progress bar that never goes away stops being read as progress. A batch is
 * shown while it has records still to deliver and has been heard from
 * recently; once done it belongs to the history table below, not here.
 */
const STALE_BATCH_MINUTES = 30;

export async function listRunningBatches(facilityIds: string[] | null): Promise<RunningBatch[]> {
  const parts: SQL[] = [inArray(syncBatches.status, ["STARTED", "UPLOADING"])];
  if (facilityIds) parts.push(inArray(syncBatches.facilityId, facilityIds));

  const rows = await db
    .select({
      agentId: agents.id,
      agentName: sql<string>`COALESCE(${agents.name}, 'Agent ที่ถูกลบแล้ว')`,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      batchRef: syncBatches.batchRef,
      rangeFrom: syncBatches.rangeFrom,
      rangeTo: syncBatches.rangeTo,
      startedAt: syncBatches.startedAt,
      recordsRead: syncBatches.recordsRead,
      recordsAccepted: syncBatches.recordsAccepted,
      recordsRejected: syncBatches.recordsRejected,
      updatedAt: syncBatches.updatedAt,
      ownerName: users.fullName,
    })
    .from(syncBatches)
    .innerJoin(agents, eq(agents.id, syncBatches.agentId))
    .innerJoin(facilities, eq(facilities.id, syncBatches.facilityId))
    .leftJoin(users, eq(users.id, agents.ownerUserId))
    .where(and(...parts))
    .orderBy(desc(syncBatches.startedAt))
    .limit(10);

  const cutoff = Date.now() - STALE_BATCH_MINUTES * 60_000;
  const live = rows
    .map((row) => ({
      ...row,
      progress:
        row.recordsRead > 0
          ? Math.min(1, (row.recordsAccepted + row.recordsRejected) / row.recordsRead)
          : 0,
    }))
    .filter((row) => {
      if (row.progress >= 1) return false;
      const heardFrom = (row.updatedAt ?? row.startedAt)?.getTime() ?? 0;
      return heardFrom >= cutoff;
    });

  // One Agent imports one thing at a time.
  //
  // A worker stopped mid-run leaves its batch UPLOADING for ever, and the
  // thirty-minute rule alone kept showing it beside the run that replaced it:
  // a สถานบริการ saw two "กำลังนำเข้าข้อมูล" cards with different date ranges and
  // no way to tell which was real. Observed on 05957 with four such rows at
  // once, only one of them advancing.
  //
  // The newest batch for an agent is the one that is happening; anything older
  // from the same agent has been superseded, whatever its status column still
  // says. The old rows stay in the database as evidence of the interruption -
  // they are simply not in progress.
  const newestPerAgent = new Map<string, (typeof live)[number]>();
  for (const row of live) {
    const held = newestPerAgent.get(row.agentId);
    if (!held) {
      newestPerAgent.set(row.agentId, row);
      continue;
    }
    const rowIsNewer = (row.startedAt?.getTime() ?? 0) > (held.startedAt?.getTime() ?? 0);
    const keep = rowIsNewer ? row : held;
    const drop = rowIsNewer ? held : row;
    newestPerAgent.set(row.agentId, keep);

    // Two batches both being written to right now is not a stale row - it is
    // two workers, which the Agent is meant to make impossible. Say so rather
    // than quietly showing one of them.
    const dropHeardFrom = (drop.updatedAt ?? drop.startedAt)?.getTime() ?? 0;
    if (Date.now() - dropHeardFrom < 2 * 60_000) {
      console.warn("[monitoring] MULTIPLE_ACTIVE_BATCHES", {
        agentId: row.agentId,
        facilityCode: row.facilityCode,
        batches: [keep.batchRef, drop.batchRef],
      });
    }
  }

  return [...newestPerAgent.values()];
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
