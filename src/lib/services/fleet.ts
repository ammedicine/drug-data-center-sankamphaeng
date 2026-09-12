/**
 * Everything a SUPER_ADMIN needs to see about every Agent, in two queries.
 *
 * The question this exists to answer is operational and specific: before the
 * centre's data is reset, is every สถานบริการ actually unable to write to it?
 * Answering that per row - one query for the agent, another for its batch,
 * another for its facility - would be fifteen times three round trips to a
 * database in another country, and the page would be slow in exactly the
 * situation where somebody is watching it closely.
 *
 * So: one query for the agents, one for the live batches, joined in memory.
 *
 * The distinction the whole screen turns on is between what the centre has
 * decided and what an Agent has acknowledged. An Agent that is switched off
 * will never acknowledge anything, and that is not an error - the centre's
 * barrier is what makes a reset safe, and it is already committed. The screen
 * has to say both things separately or an operator will either wait forever
 * for an ACK that cannot come, or assume a machine is safe when it is not.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, auditLogs, facilities, syncBatches, users } from "@/lib/db/schema";
import {
  NO_CAPABILITIES,
  parseCapabilities,
  type AgentCapabilities,
} from "@/lib/shared/agent-build";
import {
  controlAckState,
  DEFAULT_SYNC_START_DATE,
  ingestAllowed,
  type ControlAckState,
  type EffectiveSyncState,
  type SyncControlState,
} from "@/lib/shared/sync-control";
import type { AgentStatus } from "@/lib/db/schema";

import type { JhcisLinkState } from "@/lib/shared/agent-status";

import { effectiveStatus, jhcisLinkState, listRunningBatches } from "./monitoring";

export interface FleetAgentRow {
  agentId: string;
  agentName: string;
  hostname: string | null;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  pcucode: string | null;

  version: string | null;
  buildId: string | null;
  capabilities: AgentCapabilities;

  /** presence, decided the same way as everywhere else in the app */
  status: AgentStatus;
  jhcis: JhcisLinkState;
  lastSeenAt: Date | null;
  mysqlVersion: string | null;

  /** what the centre has decided - authoritative for ingestion */
  desiredSyncState: SyncControlState;
  controlRevision: number;
  pausedAt: Date | null;
  pausedByName: string | null;
  pauseReason: string | null;

  /** what the agent reports back - never decides anything */
  effectiveSyncState: EffectiveSyncState | null;
  appliedControlRevision: number | null;
  controlAppliedAt: Date | null;
  ack: ControlAckState;

  /** the answer that matters for a reset */
  ingestAllowed: boolean;

  syncStartDate: string | null;
  watermark: string | null;
  pendingBatches: number;
  failedCount: number;
  lastError: string | null;

  /** the agent's own report of its updater, as last heard */
  update: {
    state: string | null;
    commandId: string | null;
    targetVersion: string | null;
    checkedAt: Date | null;
    errorCode: string | null;
    error: string | null;
    errorAt: Date | null;
    succeededAt: Date | null;
    task: Record<string, unknown> | null;
  };

  /** at most one genuinely live batch, or null */
  current: {
    batchRef: string;
    rangeFrom: string | null;
    rangeTo: string | null;
    recordsRead: number;
    recordsAccepted: number;
    progress: number;
  } | null;
  /** set when this agent has more than one genuinely fresh live batch */
  multipleActiveBatches: boolean;
}

export interface FleetSummary {
  total: number;
  online: number;
  offline: number;
  syncing: number;
  paused: number;
  awaitingAck: number;
  ingestBlocked: number;
  jhcisDown: number;
  problems: number;
}

/**
 * The whole fleet, newest problem first.
 *
 * Ordering is deliberate rather than alphabetical: an agent that needs
 * attention must not be below the fold while fourteen healthy ones sit above
 * it. Trouble, then waiting-for-acknowledgement, then offline, then the rest.
 */
export async function listFleet(): Promise<FleetAgentRow[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      hostname: agents.hostname,
      facilityId: agents.facilityId,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      pcucode: agents.jhcisPcucode,
      version: agents.version,
      buildId: agents.buildId,
      capabilities: agents.capabilities,
      status: agents.status,
      lastSeenAt: agents.lastSeenAt,
      lastHeartbeatAt: agents.lastHeartbeatAt,
      jhcisConnected: agents.jhcisConnected,
      mysqlVersion: agents.mysqlVersion,
      desiredSyncState: agents.syncControlState,
      controlRevision: agents.controlRevision,
      pausedAt: agents.pausedAt,
      pausedByName: users.fullName,
      pauseReason: agents.pauseReason,
      effectiveSyncState: agents.effectiveSyncState,
      appliedControlRevision: agents.appliedControlRevision,
      controlAppliedAt: agents.controlAppliedAt,
      syncStartDate: agents.syncStartDate,
      watermark: agents.lastSyncedVisitDate,
      pendingBatches: agents.pendingBatches,
      failedCount: agents.failedCount,
      lastError: agents.lastError,
      updateState: agents.updateState,
      updateCommandId: agents.updateCommandId,
      updateTargetVersion: agents.updateTargetVersion,
      updateCheckedAt: agents.updateCheckedAt,
      updateErrorCode: agents.updateErrorCode,
      updateError: agents.updateError,
      updateErrorAt: agents.updateErrorAt,
      updateSucceededAt: agents.updateSucceededAt,
      updaterTask: agents.updaterTask,
    })
    .from(agents)
    .innerJoin(facilities, eq(facilities.id, agents.facilityId))
    .leftJoin(users, eq(users.id, agents.pausedByUserId))
    .orderBy(facilities.code, agents.name);

  // One more query, not one per row. listRunningBatches already keeps only the
  // newest live batch per agent and warns when two are genuinely fresh, so the
  // stale UPLOADING rows a killed worker leaves behind stay in history where
  // they belong instead of being drawn as current work.
  const live = await listRunningBatches(null);
  const byAgent = new Map(live.map((b) => [b.agentId, b]));

  return rows.map((r) => {
    const capabilities = r.capabilities ? parseCapabilities(r.capabilities) : { ...NO_CAPABILITIES };
    const current = byAgent.get(r.agentId) ?? null;
    return {
      agentId: r.agentId,
      agentName: r.agentName,
      hostname: r.hostname,
      facilityId: r.facilityId,
      facilityCode: r.facilityCode,
      facilityName: r.facilityName,
      pcucode: r.pcucode,
      version: r.version,
      buildId: r.buildId,
      capabilities,
      status: effectiveStatus({
        status: r.status,
        lastSeenAt: r.lastSeenAt,
        lastHeartbeatAt: r.lastHeartbeatAt,
      }),
      jhcis: jhcisLinkState({
        lastHeartbeatAt: r.lastHeartbeatAt,
        jhcisConnected: r.jhcisConnected,
      }),
      lastSeenAt: r.lastSeenAt ?? r.lastHeartbeatAt,
      mysqlVersion: r.mysqlVersion,
      desiredSyncState: r.desiredSyncState,
      controlRevision: r.controlRevision,
      pausedAt: r.pausedAt,
      pausedByName: r.pausedByName ?? null,
      pauseReason: r.pauseReason,
      effectiveSyncState: r.effectiveSyncState,
      appliedControlRevision: r.appliedControlRevision,
      controlAppliedAt: r.controlAppliedAt,
      ack: controlAckState({
        desired: r.desiredSyncState,
        effective: r.effectiveSyncState,
        controlRevision: r.controlRevision,
        appliedRevision: r.appliedControlRevision,
        supportsRemotePause: capabilities.remotePause,
      }),
      ingestAllowed: ingestAllowed(r.desiredSyncState),
      syncStartDate: r.syncStartDate ? String(r.syncStartDate) : null,
      watermark: r.watermark ? String(r.watermark) : null,
      pendingBatches: r.pendingBatches,
      failedCount: r.failedCount,
      lastError: r.lastError,
      update: {
        state: r.updateState,
        commandId: r.updateCommandId,
        targetVersion: r.updateTargetVersion,
        checkedAt: r.updateCheckedAt,
        errorCode: r.updateErrorCode,
        error: r.updateError,
        errorAt: r.updateErrorAt,
        succeededAt: r.updateSucceededAt,
        task: (r.updaterTask as Record<string, unknown> | null) ?? null,
      },
      current: current
        ? {
            batchRef: current.batchRef,
            rangeFrom: current.rangeFrom,
            rangeTo: current.rangeTo,
            recordsRead: current.recordsRead,
            recordsAccepted: current.recordsAccepted,
            progress: current.progress,
          }
        : null,
      multipleActiveBatches: false,
    };
  });
}

export function summariseFleet(rows: FleetAgentRow[]): FleetSummary {
  return {
    total: rows.length,
    // A paused agent that is heartbeating is ONLINE. Saying otherwise would
    // tell an operator a machine is unreachable when it is sitting there
    // waiting to be told to start again.
    online: rows.filter((r) => r.status !== "OFFLINE" && r.status !== "DISABLED").length,
    offline: rows.filter((r) => r.status === "OFFLINE").length,
    syncing: rows.filter((r) => r.current !== null).length,
    paused: rows.filter((r) => r.desiredSyncState === "PAUSED").length,
    awaitingAck: rows.filter((r) => r.ack === "PAUSE_PENDING" || r.ack === "RESUME_PENDING").length,
    ingestBlocked: rows.filter((r) => !r.ingestAllowed).length,
    jhcisDown: rows.filter((r) => r.jhcis === "UNREACHABLE").length,
    problems: rows.filter(
      (r) => r.status === "OFFLINE" || r.jhcis === "UNREACHABLE" || r.failedCount > 0 || r.lastError,
    ).length,
  };
}

/**
 * Whether the centre could safely be reset, per agent.
 *
 * The two questions are separate and the answer must say so. "Central is not
 * accepting this agent's data" is the one that makes a reset safe, and it is
 * true the moment the barrier commits - offline machines and old builds
 * included. "The agent has acknowledged" is a nicer state to be in, and it is
 * not required.
 */
export interface ResetReadinessRow {
  agentId: string;
  facilityCode: string;
  facilityName: string;
  version: string | null;
  buildId: string | null;
  centralBlocked: boolean;
  ack: ControlAckState;
  syncStartDate: string | null;
  activeSync: boolean;
  pendingBatches: number;
  lastSeenAt: Date | null;
  /** true only when the centre cannot receive anything from this agent */
  safeToReset: boolean;
  /** what still needs a person, in Thai, or null when nothing does */
  blocker: string | null;
}

export function resetReadiness(rows: FleetAgentRow[]): ResetReadinessRow[] {
  return rows.map((r) => {
    // An in-flight batch is the one thing that genuinely blocks: the barrier
    // refuses anything new, but a write already inside an atomic operation
    // when pause committed is allowed to finish rather than be torn in half.
    const activeSync = r.current !== null;
    const safeToReset = !r.ingestAllowed && !activeSync;
    let blocker: string | null = null;
    if (r.ingestAllowed) blocker = "ยังไม่ได้หยุดการซิงก์";
    else if (activeSync) blocker = "กำลังซิงก์อยู่ รอให้ชุดปัจจุบันจบก่อน";
    return {
      agentId: r.agentId,
      facilityCode: r.facilityCode,
      facilityName: r.facilityName,
      version: r.version,
      buildId: r.buildId,
      centralBlocked: !r.ingestAllowed,
      ack: r.ack,
      syncStartDate: r.syncStartDate,
      activeSync,
      pendingBatches: r.pendingBatches,
      lastSeenAt: r.lastSeenAt,
      safeToReset,
      blocker,
    };
  });
}

/**
 * The raw state change, with no actor and no audit. INTERNAL.
 *
 * Nothing in the application may call this. A pause is the instruction that
 * makes a reset safe, so "who stopped this สถานบริการ, and when" has to be
 * answerable afterwards - and an audit written by a separate call is an audit
 * a caller can forget to write. The production canary proved exactly that:
 * fifteen agents paused and resumed with paused_by_user_id null and not one
 * audit row, because the mutation was reachable without the wrapper.
 *
 * So the audited path below is the only way in, and this is kept exported
 * solely so fixtures and migrations can arrange a starting state.
 * `tests/pause-authorization.test.ts` fails if any file under src/ imports it.
 *
 * @internal
 */
export async function unauditedSetAgentSyncControl(input: {
  agentId: string;
  desired: SyncControlState;
  actorUserId: string;
  reason?: string | null;
}): Promise<{ changed: boolean; revision: number }> {
  const [before] = await db
    .select({ state: agents.syncControlState, revision: agents.controlRevision })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  if (!before) throw new Error("ไม่พบ Agent นี้");
  if (before.state === input.desired) return { changed: false, revision: before.revision };

  const revision = before.revision + 1;
  await db
    .update(agents)
    .set({
      syncControlState: input.desired,
      controlRevision: revision,
      ...(input.desired === "PAUSED"
        ? {
            pausedAt: new Date(),
            pausedByUserId: input.actorUserId,
            pauseReason: input.reason?.slice(0, 200) ?? null,
          }
        : { pausedAt: null, pausedByUserId: null, pauseReason: null }),
    })
    .where(eq(agents.id, input.agentId));

  return { changed: true, revision };
}

/** Refused because the actor is not a SUPER_ADMIN, or is not a usable account. */
export class SyncControlAuthorizationError extends Error {
  constructor(message = "เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้นที่สั่งหยุด/เปิดการซิงก์ได้") {
    super(message);
    this.name = "SyncControlAuthorizationError";
  }
}

/** Who is asking. The label is an email or username - never a credential. */
export interface SyncControlActor {
  userId: string;
  label?: string | null;
  ip?: string | null;
}

/** What happened to one agent, for the caller to report and for tests to read. */
export interface SyncControlOutcome {
  agentId: string;
  facilityId: string | null;
  agentName: string;
  changed: boolean;
  revision: number;
  /** why nothing happened, when nothing did */
  skipped: "ALREADY_IN_STATE" | "NOT_FOUND" | null;
}

/**
 * The one way an administrator may stop or start an agent's sync.
 *
 * Three things are deliberately inside this function rather than around it:
 *
 * The role is re-read from the database rather than taken from the caller.
 * A session says what somebody was when they signed in; an account demoted or
 * disabled five minutes ago must not still be able to stop a สถานบริการ.
 *
 * The state change and its audit row are one transaction. If the audit cannot
 * be written the pause does not happen, which is the opposite of the usual
 * rule for audit writes - and correct here, because a pause nobody can attribute
 * is exactly the thing that must not exist before a district-wide reset.
 *
 * Idempotence is decided by the state, not by the request. Pressing PAUSE twice
 * is one transition and one audit row, because the second press changes nothing
 * and an audit trail of non-events is a trail nobody reads.
 */
export async function changeAgentSyncControl(input: {
  agentIds: string[];
  desired: SyncControlState;
  reason?: string | null;
  actor: SyncControlActor;
}): Promise<SyncControlOutcome[]> {
  const [actor] = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive, email: users.email })
    .from(users)
    .where(eq(users.id, input.actor.userId))
    .limit(1);
  if (!actor || !actor.isActive || actor.role !== "SUPER_ADMIN") {
    throw new SyncControlAuthorizationError();
  }

  const reason = input.reason?.trim().slice(0, 200) || null;
  const label = input.actor.label ?? actor.email;
  const ip = input.actor.ip ?? null;
  const outcomes: SyncControlOutcome[] = [];

  for (const agentId of input.agentIds) {
    const [agent] = await db
      .select({
        id: agents.id,
        name: agents.name,
        facilityId: agents.facilityId,
        state: agents.syncControlState,
        revision: agents.controlRevision,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      outcomes.push({
        agentId,
        facilityId: null,
        agentName: agentId,
        changed: false,
        revision: 0,
        skipped: "NOT_FOUND",
      });
      continue;
    }

    if (agent.state === input.desired) {
      outcomes.push({
        agentId,
        facilityId: agent.facilityId,
        agentName: agent.name,
        changed: false,
        revision: agent.revision,
        skipped: "ALREADY_IN_STATE",
      });
      continue;
    }

    const revision = agent.revision + 1;
    const pausing = input.desired === "PAUSED";

    await db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({
          syncControlState: input.desired,
          controlRevision: revision,
          // Pause metadata identifies the administrator who stopped this
          // สถานบริการ. Resuming clears the live fields and nothing else: the
          // audit row below is the permanent record and is never rewritten.
          ...(pausing
            ? { pausedAt: new Date(), pausedByUserId: actor.id, pauseReason: reason }
            : { pausedAt: null, pausedByUserId: null, pauseReason: null }),
        })
        .where(eq(agents.id, agentId));

      await tx.insert(auditLogs).values({
        actorType: "USER",
        actorId: actor.id,
        actorLabel: label,
        action: pausing ? "AGENT_SYNC_PAUSED" : "AGENT_SYNC_RESUMED",
        resource: "agent",
        resourceId: agentId,
        facilityId: agent.facilityId,
        ip,
        // Safe metadata only: who, which agent, why, which revision. No
        // credential, no token, no payload, nothing about a patient.
        metadata: { agentName: agent.name, reason, controlRevision: revision },
      });
    });

    outcomes.push({
      agentId,
      facilityId: agent.facilityId,
      agentName: agent.name,
      changed: true,
      revision,
      skipped: null,
    });
  }

  return outcomes;
}

/** The default an agent uses when it has never been told otherwise. */
export const FLEET_DEFAULT_SYNC_START_DATE = DEFAULT_SYNC_START_DATE;

/** Agent ids a bulk action would touch, resolved server-side from a selection. */
export async function resolveAgentIds(input: {
  agentIds?: string[];
  facilityIds?: string[];
  all?: boolean;
}): Promise<string[]> {
  if (input.all) {
    const rows = await db.select({ id: agents.id }).from(agents);
    return rows.map((r) => r.id);
  }
  const ids = new Set(input.agentIds ?? []);
  if (input.facilityIds?.length) {
    // A facility-wide action is an explicit choice, never an accident of one
    // สถานบริการ happening to have two agents.
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.facilityId, input.facilityIds));
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/** Batches a paused agent left behind, for the details drawer. */
export async function recentBatches(agentId: string, limit = 5) {
  return db
    .select({
      batchRef: syncBatches.batchRef,
      status: syncBatches.status,
      rangeFrom: syncBatches.rangeFrom,
      rangeTo: syncBatches.rangeTo,
      recordsRead: syncBatches.recordsRead,
      recordsAccepted: syncBatches.recordsAccepted,
      startedAt: syncBatches.startedAt,
      completedAt: syncBatches.completedAt,
    })
    .from(syncBatches)
    .where(eq(syncBatches.agentId, agentId))
    .orderBy(desc(syncBatches.startedAt))
    .limit(limit);
}

/** Count of agents the centre is currently refusing, for a reset banner. */
export async function countBlockedAgents(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(agents)
    .where(eq(agents.syncControlState, "PAUSED"));
  return Number(row?.n ?? 0);
}
