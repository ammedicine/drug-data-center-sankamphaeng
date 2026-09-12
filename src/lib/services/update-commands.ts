/**
 * Remote software updates, decided at the centre and remembered in the database.
 *
 * Three doors, and only three:
 *
 *  requestAgentUpdates  - an operator asks. One durable row per Agent, pinned
 *                         to the release that is published right now, written
 *                         together with its audit row.
 *  deliverUpdateCommand - an Agent heartbeats. If it is owed a command and a
 *                         rollout slot is free, the row becomes DELIVERED and
 *                         the command rides back in the heartbeat response.
 *  applyAgentUpdateReport - the same Agent says how it is getting on. The row
 *                         moves only along the transition table; a SUCCESS is
 *                         audited; a stuck row is timed out.
 *
 * Nothing here holds state in memory across requests. Vercel would lose it.
 * The bound on concurrent installs is a conditional UPDATE against a count in
 * the same table, so two heartbeats arriving in the same second on two
 * function instances cannot both take the last slot.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, agentUpdateCommands, auditLogs, facilities, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { parseCapabilities } from "@/lib/shared/agent-build";
import {
  canTransition,
  MAX_ACTIVE_ROLLOUT,
  ROLLOUT_ACTIVE_STATES,
  ROLLOUT_SLOT_STALE_MINUTES,
  TERMINAL_UPDATE_STATES,
  UPDATE_COMMAND_TIMEOUT_HOURS,
  type UpdateCommandState,
  type UpdateErrorCode,
} from "@/lib/shared/update-command";
import { compareVersions, isNewerVersion } from "@/lib/shared/version";

import { lookupLatestAgentRelease } from "./agent-release";

/** Refused because the actor is not a usable SUPER_ADMIN. Re-read from the database, never trusted from a session. */
export class UpdateAuthorizationError extends Error {
  constructor(message = "เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้นที่สั่งอัปเดต Agent ได้") {
    super(message);
    this.name = "UpdateAuthorizationError";
  }
}

/** The published release is not in a state anyone should be installing. */
export class NoInstallableReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoInstallableReleaseError";
  }
}

export interface UpdateActor {
  userId: string;
  label?: string | null;
  ip?: string | null;
}

/** What the operator's request did to one Agent. */
export interface UpdateRequestOutcome {
  agentId: string;
  agentName: string;
  facilityId: string | null;
  currentVersion: string | null;
  targetVersion: string;
  outcome: "REQUESTED" | "DUPLICATE" | "ALREADY_UP_TO_DATE" | "UNSUPPORTED_CLIENT" | "NOT_FOUND";
  commandId: string | null;
  /** an older active command this request replaced, if any */
  supersededCommandId: string | null;
}

/** What rides back to the Agent in the heartbeat response. */
export interface DeliveredUpdateCommand {
  id: string;
  targetVersion: string;
  assetName: string;
  size: number | null;
  sha256: string;
}

/** What the Agent reports about a command, or about its own scheduled updater. */
export interface AgentUpdateReport {
  commandId?: string | null;
  state?: string | null;
  targetVersion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorAt?: string | null;
  succeededAt?: string | null;
  checkedAt?: string | null;
  task?: Record<string, unknown> | null;
}

const SAFE_TEXT = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").slice(0, max) : null;

/** The release an operator's click pins to. Fresh, never cached: what they approve is what installs. */
async function currentTarget() {
  const lookup = await lookupLatestAgentRelease("fresh");
  if (lookup.status !== "ok") {
    throw new NoInstallableReleaseError(
      lookup.status === "none-published"
        ? "ยังไม่มีรุ่นที่เผยแพร่"
        : `อ่านรุ่นล่าสุดจาก GitHub ไม่ได้ (${"detail" in lookup ? lookup.detail : lookup.status})`,
    );
  }
  const { release } = lookup;
  if (!release.sha256) {
    throw new NoInstallableReleaseError("รุ่นที่เผยแพร่ไม่มีค่าตรวจสอบไฟล์ (SHA-256) จึงสั่งติดตั้งอัตโนมัติไม่ได้");
  }
  return {
    version: release.version.replace(/^v/i, ""),
    assetName: release.fileName,
    size: release.sizeBytes,
    sha256: release.sha256.toLowerCase(),
  };
}

async function requireSuperAdmin(userId: string) {
  const [actor] = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!actor || !actor.isActive || actor.role !== "SUPER_ADMIN") throw new UpdateAuthorizationError();
  return actor;
}

/**
 * One operator click, for one or many Agents.
 *
 * Every Agent gets its own row and its own audit line, in one transaction per
 * Agent, so a multi-select of fifteen is fifteen independent commands that
 * share a groupId for the screen and nothing else. An Agent already on the
 * target is answered ALREADY_UP_TO_DATE and gets no row; one that cannot act
 * on a command (1.1.7 - 1.1.9) is answered UNSUPPORTED_CLIENT and gets no row
 * either - the truth, rather than a row that would sit at REQUESTED for ever.
 * A second click while a command is active is a DUPLICATE and returns the
 * existing command; only a genuinely newer target supersedes.
 */
export async function requestAgentUpdates(input: {
  agentIds: string[];
  actor: UpdateActor;
  /** the published release to pin to; production always uses the GitHub lookup, harnesses inject one */
  resolveTarget?: typeof currentTarget;
}): Promise<{ groupId: string; target: { version: string; assetName: string; size: number | null; sha256: string }; outcomes: UpdateRequestOutcome[] }> {
  const actor = await requireSuperAdmin(input.actor.userId);
  const target = await (input.resolveTarget ?? currentTarget)();
  const groupId = newId();
  const label = input.actor.label ?? actor.email;
  const ip = input.actor.ip ?? null;
  const now = new Date();
  const outcomes: UpdateRequestOutcome[] = [];

  for (const agentId of input.agentIds) {
    const [agent] = await db
      .select({
        id: agents.id,
        name: agents.name,
        facilityId: agents.facilityId,
        version: agents.version,
        capabilities: agents.capabilities,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      outcomes.push({ agentId, agentName: agentId, facilityId: null, currentVersion: null, targetVersion: target.version, outcome: "NOT_FOUND", commandId: null, supersededCommandId: null });
      continue;
    }
    const base = { agentId, agentName: agent.name, facilityId: agent.facilityId, currentVersion: agent.version, targetVersion: target.version };

    if (!isNewerVersion(target.version, agent.version)) {
      outcomes.push({ ...base, outcome: "ALREADY_UP_TO_DATE", commandId: null, supersededCommandId: null });
      continue;
    }
    if (!parseCapabilities(agent.capabilities as Record<string, unknown> | null).remoteUpdate) {
      outcomes.push({ ...base, outcome: "UNSUPPORTED_CLIENT", commandId: null, supersededCommandId: null });
      continue;
    }

    const [active] = await db
      .select({ id: agentUpdateCommands.id, targetVersion: agentUpdateCommands.targetVersion, status: agentUpdateCommands.status })
      .from(agentUpdateCommands)
      .where(and(eq(agentUpdateCommands.agentId, agentId), inArray(agentUpdateCommands.status, ["REQUESTED", ...ROLLOUT_ACTIVE_STATES])))
      .orderBy(desc(agentUpdateCommands.requestedAt))
      .limit(1);

    if (active && (compareVersions(active.targetVersion, target.version) ?? 0) >= 0) {
      outcomes.push({ ...base, outcome: "DUPLICATE", commandId: active.id, supersededCommandId: null });
      continue;
    }

    const commandId = newId();
    await db.transaction(async (tx) => {
      if (active) {
        // An older target still pending is replaced, not left to race the new one.
        await tx
          .update(agentUpdateCommands)
          .set({ status: "SUPERSEDED", statusChangedAt: now, completedAt: now })
          .where(and(eq(agentUpdateCommands.id, active.id), eq(agentUpdateCommands.status, "REQUESTED")));
      }
      await tx.insert(agentUpdateCommands).values({
        id: commandId,
        agentId,
        facilityId: agent.facilityId,
        groupId,
        targetVersion: target.version,
        targetAssetName: target.assetName,
        targetSize: target.size,
        targetSha256: target.sha256,
        versionAtRequest: agent.version,
        requestedByUserId: actor.id,
        requestedAt: now,
        status: "REQUESTED",
        statusChangedAt: now,
      });
      await tx.insert(auditLogs).values({
        actorType: "USER",
        actorId: actor.id,
        actorLabel: label,
        action: "AGENT_UPDATE_REQUESTED",
        resource: "agent",
        resourceId: agentId,
        facilityId: agent.facilityId,
        ip,
        // Safe metadata only: versions, ids, nothing that opens anything.
        metadata: {
          agentName: agent.name,
          commandId,
          groupId,
          currentVersion: agent.version,
          targetVersion: target.version,
          supersededCommandId: active?.status === "REQUESTED" ? active.id : null,
        },
      });
    });

    outcomes.push({ ...base, outcome: "REQUESTED", commandId, supersededCommandId: active?.status === "REQUESTED" ? active.id : null });
  }

  return { groupId, target, outcomes };
}

/** An operator withdraws a command that no Agent has picked up yet. */
export async function cancelUpdateCommand(input: { commandId: string; actor: UpdateActor }): Promise<boolean> {
  const actor = await requireSuperAdmin(input.actor.userId);
  const [row] = await db
    .select({ id: agentUpdateCommands.id, agentId: agentUpdateCommands.agentId, facilityId: agentUpdateCommands.facilityId, status: agentUpdateCommands.status, targetVersion: agentUpdateCommands.targetVersion })
    .from(agentUpdateCommands)
    .where(eq(agentUpdateCommands.id, input.commandId))
    .limit(1);
  if (!row || !canTransition(row.status, "CANCELLED")) return false;
  const now = new Date();
  await db.transaction(async (tx) => {
    const result = await tx
      .update(agentUpdateCommands)
      .set({ status: "CANCELLED", statusChangedAt: now, completedAt: now })
      .where(and(eq(agentUpdateCommands.id, row.id), eq(agentUpdateCommands.status, "REQUESTED")));
    void result;
    await tx.insert(auditLogs).values({
      actorType: "USER",
      actorId: actor.id,
      actorLabel: input.actor.label ?? actor.email,
      action: "AGENT_UPDATE_CANCELLED",
      resource: "agent",
      resourceId: row.agentId,
      facilityId: row.facilityId,
      ip: input.actor.ip ?? null,
      metadata: { commandId: row.id, targetVersion: row.targetVersion },
    });
  });
  return true;
}

/**
 * Times out commands nobody has finished, so the screen tells the truth.
 *
 * Given the Agent's open rows (already read for delivery), so a heartbeat
 * with nothing open costs no extra statement. Idempotent.
 */
async function expireStaleCommands(open: Array<typeof agentUpdateCommands.$inferSelect>, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - UPDATE_COMMAND_TIMEOUT_HOURS * 3_600_000;
  const stale = open.filter((r) => ROLLOUT_ACTIVE_STATES.includes(r.status) && r.statusChangedAt.getTime() < cutoff);
  for (const row of stale) {
    await finish(row, "FAILED", "UPDATE_TIMED_OUT", `ไม่ได้รับผลจาก Agent ภายใน ${UPDATE_COMMAND_TIMEOUT_HOURS} ชั่วโมง`, null, now);
  }
  return stale.map((r) => r.id);
}

/**
 * What an Agent is owed on this heartbeat, if anything.
 *
 * An already-delivered, still-active command is handed back again every time
 * - the Agent deduplicates by id, and repeating it is what makes a lost
 * response harmless. A REQUESTED command is promoted to DELIVERED only if a
 * rollout slot is free, decided by one conditional UPDATE so concurrent
 * heartbeats cannot both win the last slot. An Agent that cannot act on
 * commands is never handed one.
 */
export async function deliverUpdateCommand(input: {
  agentId: string;
  capabilities: Record<string, unknown> | null | undefined;
  /** the Agent's open rows, when the caller already has them */
  open?: Array<typeof agentUpdateCommands.$inferSelect>;
}): Promise<DeliveredUpdateCommand | null> {
  if (!parseCapabilities(input.capabilities ?? null).remoteUpdate) return null;
  const now = new Date();
  const open = input.open ?? (await openCommandsFor(input.agentId));
  if (!open.length) return null;

  const expired = new Set(await expireStaleCommands(open, now));
  const live = open.filter((r) => !expired.has(r.id));

  const current = live
    .filter((r) => ROLLOUT_ACTIVE_STATES.includes(r.status))
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
  if (current) return toDelivered(current);

  const pending = live
    .filter((r) => r.status === "REQUESTED")
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())[0];
  if (!pending) return null;

  const staleCutoff = new Date(now.getTime() - ROLLOUT_SLOT_STALE_MINUTES * 60_000);
  const activeList = ROLLOUT_ACTIVE_STATES.map((s) => `'${s}'`).join(",");
  // The slot count and the promotion are one statement. A derived table is
  // required because MySQL will not read the table being updated directly.
  const result = await db.execute(sql`
    UPDATE agent_update_commands
    SET status = 'DELIVERED', status_changed_at = ${now}, delivered_at = ${now}
    WHERE id = ${pending.id}
      AND status = 'REQUESTED'
      AND (
        SELECT COUNT(*) FROM (
          SELECT 1 FROM agent_update_commands
          WHERE status IN (${sql.raw(activeList)})
            AND status_changed_at > ${staleCutoff}
        ) AS active_rollout
      ) < ${MAX_ACTIVE_ROLLOUT}
  `);
  const affected = Number((result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
  if (affected !== 1) return null; // no slot free yet; the row stays REQUESTED and is offered next time

  return toDelivered({ ...pending, status: "DELIVERED" });
}

/** Every non-terminal row for one Agent - the single read a heartbeat needs. */
export async function openCommandsFor(agentId: string) {
  return db
    .select()
    .from(agentUpdateCommands)
    .where(and(eq(agentUpdateCommands.agentId, agentId), inArray(agentUpdateCommands.status, ["REQUESTED", ...ROLLOUT_ACTIVE_STATES])));
}

function toDelivered(row: typeof agentUpdateCommands.$inferSelect): DeliveredUpdateCommand {
  return {
    id: row.id,
    targetVersion: row.targetVersion,
    assetName: row.targetAssetName,
    size: row.targetSize ?? null,
    sha256: row.targetSha256,
  };
}

/**
 * The Agent's report, applied.
 *
 * Only transitions the table allows are stored. A report for a command that
 * is not this Agent's is ignored - an Agent can only ever talk about its own
 * rows. A running version at or above the target closes any open command as
 * SUCCESS even if the Agent never got to say so, which is what happens when
 * the installer restarts it. SUCCESS and FAILED are audited from the trusted
 * Agent identity. The agents-table snapshot is written only when it changed.
 */
export async function applyAgentUpdateReport(input: {
  agentId: string;
  runningVersion: string | null;
  report: AgentUpdateReport | null | undefined;
  /** the Agent's open rows, read once by the caller */
  open: Array<typeof agentUpdateCommands.$inferSelect>;
}): Promise<Array<typeof agentUpdateCommands.$inferSelect>> {
  const report = input.report ?? {};
  const now = new Date();
  const closed = new Set<string>();

  // 1. The command, if the report names one and it is this Agent's.
  if (report.commandId) {
    const row = input.open.find((r) => r.id === report.commandId);
    if (row) {
      const done = await applyToCommand(row, report, input.runningVersion, now);
      if (done) closed.add(row.id);
    }
  }

  // 2. Reconciliation: any open command whose target the Agent is now running.
  for (const row of input.open) {
    if (closed.has(row.id) || !ROLLOUT_ACTIVE_STATES.includes(row.status)) continue;
    if (input.runningVersion && (compareVersions(input.runningVersion, row.targetVersion) ?? -1) >= 0) {
      await finish(row, "SUCCESS", null, null, input.runningVersion, now);
      closed.add(row.id);
    }
  }

  if (!input.report) return input.open.filter((r) => !closed.has(r.id));

  // 3. The snapshot on the agent row, only when something differs.
  const [snapshot] = await db
    .select({
      updateState: agents.updateState,
      updateCommandId: agents.updateCommandId,
      updateTargetVersion: agents.updateTargetVersion,
      updateErrorCode: agents.updateErrorCode,
      updateError: agents.updateError,
      updaterTask: agents.updaterTask,
    })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  const remaining = input.open.filter((r) => !closed.has(r.id));
  if (!snapshot) return remaining;

  const next = {
    updateState: SAFE_TEXT(report.state, 24) ?? snapshot.updateState,
    updateCommandId: report.commandId ?? snapshot.updateCommandId,
    updateTargetVersion: SAFE_TEXT(report.targetVersion, 40) ?? snapshot.updateTargetVersion,
    updateErrorCode: report.errorCode === undefined ? snapshot.updateErrorCode : SAFE_TEXT(report.errorCode, 40),
    updateError: report.errorCode === undefined ? snapshot.updateError : SAFE_TEXT(report.errorMessage, 400),
    updaterTask: report.task === undefined ? snapshot.updaterTask : (report.task ?? null),
  };
  const changed =
    next.updateState !== snapshot.updateState ||
    next.updateCommandId !== snapshot.updateCommandId ||
    next.updateTargetVersion !== snapshot.updateTargetVersion ||
    next.updateErrorCode !== snapshot.updateErrorCode ||
    next.updateError !== snapshot.updateError ||
    JSON.stringify(next.updaterTask ?? null) !== JSON.stringify(snapshot.updaterTask ?? null) ||
    Boolean(report.checkedAt) ||
    Boolean(report.succeededAt);
  if (!changed) return remaining;

  await db
    .update(agents)
    .set({
      ...next,
      ...(report.checkedAt ? { updateCheckedAt: safeDate(report.checkedAt) ?? now } : {}),
      ...(report.errorCode ? { updateErrorAt: safeDate(report.errorAt) ?? now } : {}),
      ...(report.succeededAt ? { updateSucceededAt: safeDate(report.succeededAt) ?? now } : {}),
    })
    .where(eq(agents.id, input.agentId));
  return remaining;
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function applyToCommand(
  row: typeof agentUpdateCommands.$inferSelect,
  report: AgentUpdateReport,
  runningVersion: string | null,
  now: Date,
): Promise<boolean> {
  const state = report.state as UpdateCommandState | undefined;
  if (!state) return false;
  if (state === "SUCCESS" || state === "FAILED") {
    if (!canTransition(row.status, state)) return false;
    await finish(row, state, SAFE_TEXT(report.errorCode, 40) as UpdateErrorCode | null, SAFE_TEXT(report.errorMessage, 400), runningVersion, now);
    return true;
  }
  if (!canTransition(row.status, state)) return false;
  if (state === row.status) return false; // repeated report, nothing to write
  await db
    .update(agentUpdateCommands)
    .set({
      status: state,
      statusChangedAt: now,
      ...(row.status === "DELIVERED" ? { attempts: sql`${agentUpdateCommands.attempts} + 1` } : {}),
    })
    .where(and(eq(agentUpdateCommands.id, row.id), eq(agentUpdateCommands.status, row.status)));
  row.status = state;
  row.statusChangedAt = now;
  return false;
}

async function finish(
  row: typeof agentUpdateCommands.$inferSelect,
  state: "SUCCESS" | "FAILED",
  errorCode: string | null,
  errorMessage: string | null,
  runningVersion: string | null,
  now: Date,
): Promise<void> {
  if (TERMINAL_UPDATE_STATES.includes(row.status)) return;
  await db.transaction(async (tx) => {
    const result = await tx
      .update(agentUpdateCommands)
      .set({
        status: state,
        statusChangedAt: now,
        completedAt: now,
        resultVersion: runningVersion,
        ...(state === "FAILED"
          ? { lastErrorCode: errorCode, lastErrorMessage: errorMessage, lastErrorAt: now }
          : {}),
      })
      .where(and(eq(agentUpdateCommands.id, row.id), eq(agentUpdateCommands.status, row.status)));
    const affected = Number((result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
    if (affected !== 1) return; // somebody else finished it first
    await tx.insert(auditLogs).values({
      actorType: "AGENT",
      actorId: row.agentId,
      actorLabel: null,
      action: state === "SUCCESS" ? "AGENT_UPDATE_COMPLETED" : "AGENT_UPDATE_FAILED",
      resource: "agent",
      resourceId: row.agentId,
      facilityId: row.facilityId,
      metadata: {
        commandId: row.id,
        groupId: row.groupId,
        targetVersion: row.targetVersion,
        resultVersion: runningVersion,
        ...(state === "FAILED" ? { errorCode, errorMessage } : {}),
      },
    });
  });
}

/** The newest command per Agent, for the fleet screen - one query. */
export async function latestUpdateCommands(): Promise<Map<string, typeof agentUpdateCommands.$inferSelect & { requestedByName: string | null }>> {
  const rows = await db
    .select({ command: agentUpdateCommands, requestedByName: users.fullName })
    .from(agentUpdateCommands)
    .leftJoin(users, eq(users.id, agentUpdateCommands.requestedByUserId))
    .orderBy(desc(agentUpdateCommands.requestedAt));
  const out = new Map<string, typeof agentUpdateCommands.$inferSelect & { requestedByName: string | null }>();
  for (const r of rows) {
    if (!out.has(r.command.agentId)) out.set(r.command.agentId, { ...r.command, requestedByName: r.requestedByName });
  }
  return out;
}

/** Agents by id with facility, for a confirmation dialog. */
export async function describeAgents(agentIds: string[]) {
  if (!agentIds.length) return [];
  return db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      version: agents.version,
      capabilities: agents.capabilities,
    })
    .from(agents)
    .innerJoin(facilities, eq(facilities.id, agents.facilityId))
    .where(inArray(agents.id, agentIds));
}
