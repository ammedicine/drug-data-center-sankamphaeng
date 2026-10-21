import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  agents,
  auditLogs,
  globalSyncBackfillRequests,
  syncBatches,
  systemSettings,
  users,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { parseCapabilities } from "@/lib/shared/agent-build";
import type { AuthenticatedAgent } from "@/lib/agent-auth/verify";
import {
  GLOBAL_SYNC_START_DATE_POLICY_KEY,
  parseGlobalSyncStartDatePolicy,
  type GlobalSyncStartDatePolicy,
} from "./global-sync-policy";

export type GlobalSyncBackfillStatus =
  "REQUESTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED";

export class GlobalSyncBackfillError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GlobalSyncBackfillError";
  }
}

export interface BackfillEligibilityInput {
  actor: { id: string; role: string; isActive: boolean };
  agent: {
    id: string;
    facilityId: string;
    online: boolean;
    capabilities: {
      remoteSyncStartDate: boolean;
      idempotentUploadChunk: boolean;
    };
    appliedPolicyRevision: number | null;
    desiredSyncState: "RUNNING" | "PAUSED";
    effectiveSyncState: "RUNNING" | "PAUSE_REQUESTED" | "PAUSED" | null;
    queuePendingCount: number | null;
    queueFailedCount: number | null;
    queueTelemetryAt: Date | null;
  };
  policy: GlobalSyncStartDatePolicy | null;
  rangeFrom: string;
  rangeTo: string;
  reason: string;
  hasOpenRequest: boolean;
  hasActiveBatch: boolean;
  hasManualRequest: boolean;
  now: Date;
}

export interface GlobalSyncBackfillRequestRecord {
  id: string;
  agentId: string;
  facilityId: string;
  policyRevision: number;
  rangeFrom: string;
  rangeTo: string;
  requestedByUserId: string;
  reason: string;
  status: GlobalSyncBackfillStatus;
  linkedBatchId: string | null;
  requestedAt: Date;
}

export function assertBackfillRequestEligible(
  _input: BackfillEligibilityInput,
): void {
  const input = _input;
  const refuse = (code: string, message: string): never => {
    throw new GlobalSyncBackfillError(code, message);
  };
  if (!input.actor.isActive || input.actor.role !== "SUPER_ADMIN") {
    refuse(
      "FORBIDDEN",
      "Only an active SUPER_ADMIN may request historical backfill",
    );
  }
  const plan = input.policy?.backfillPlan;
  if (!input.policy?.activeDate || !plan || plan.status !== "ACTIVE") {
    refuse("BACKFILL_PLAN_MISSING", "No active historical backfill plan");
  }
  const policy = input.policy as GlobalSyncStartDatePolicy & {
    activeDate: string;
    backfillPlan: NonNullable<GlobalSyncStartDatePolicy["backfillPlan"]>;
  };
  const activePlan = policy.backfillPlan;
  if (activePlan.policyRevision !== policy.activeRevision) {
    refuse(
      "POLICY_REVISION_MISMATCH",
      "Backfill plan is not the active policy revision",
    );
  }
  if (
    !input.agent.capabilities.remoteSyncStartDate ||
    !input.agent.capabilities.idempotentUploadChunk
  ) {
    refuse(
      "CAPABILITY_REQUIRED",
      "Agent lacks a required historical backfill capability",
    );
  }
  if (input.agent.appliedPolicyRevision !== policy.activeRevision) {
    refuse(
      "POLICY_REVISION_MISMATCH",
      "Agent has not applied the active policy revision",
    );
  }
  if (input.agent.desiredSyncState !== "PAUSED") {
    refuse("PAUSE_REQUIRED", "Agent must be centrally paused");
  }
  if (input.agent.online && input.agent.effectiveSyncState !== "PAUSED") {
    refuse(
      "EFFECTIVE_PAUSE_REQUIRED",
      "Online Agent must report effective PAUSED state",
    );
  }
  const telemetryAt = input.agent.queueTelemetryAt?.getTime() ?? 0;
  if (
    input.agent.queuePendingCount === null ||
    input.agent.queueFailedCount === null ||
    telemetryAt === 0 ||
    input.now.getTime() - telemetryAt > 5 * 60_000
  ) {
    refuse("TELEMETRY_UNKNOWN", "Current Agent queue telemetry is required");
  }
  if ((input.agent.queuePendingCount ?? 0) > 0) {
    refuse("QUEUE_NOT_EMPTY", "Pending queue must be empty");
  }
  if ((input.agent.queueFailedCount ?? 0) > 0) {
    refuse("FAILED_QUEUE_NOT_EMPTY", "Failed queue must be empty");
  }
  if (input.hasOpenRequest)
    refuse("OPEN_REQUEST", "Another historical request is open");
  if (input.hasActiveBatch)
    refuse("ACTIVE_BATCH", "A Central sync batch is active");
  if (input.hasManualRequest)
    refuse("MANUAL_REQUEST", "A manual sync request is outstanding");
  if (
    input.rangeFrom > input.rangeTo ||
    input.rangeFrom < policy.activeDate ||
    input.rangeFrom < activePlan.from ||
    input.rangeTo > activePlan.to
  ) {
    refuse(
      "RANGE_NOT_AUTHORIZED",
      "Requested range is outside the active backfill plan",
    );
  }
  if (!input.reason.trim())
    refuse("REASON_REQUIRED", "Backfill reason is required");
}

export function buildBackfillRequest(
  input: BackfillEligibilityInput,
  requestId: string,
): GlobalSyncBackfillRequestRecord {
  assertBackfillRequestEligible(input);
  if (!input.policy)
    throw new GlobalSyncBackfillError(
      "BACKFILL_PLAN_MISSING",
      "Policy missing",
    );
  return {
    id: requestId,
    agentId: input.agent.id,
    facilityId: input.agent.facilityId,
    policyRevision: input.policy.activeRevision,
    rangeFrom: input.rangeFrom,
    rangeTo: input.rangeTo,
    requestedByUserId: input.actor.id,
    reason: input.reason.trim().slice(0, 500),
    status: "REQUESTED",
    linkedBatchId: null,
    requestedAt: input.now,
  };
}

export function assertBackfillTransition(
  from: GlobalSyncBackfillStatus,
  to: GlobalSyncBackfillStatus,
): void {
  if (from === to) return;
  const allowed: Record<GlobalSyncBackfillStatus, GlobalSyncBackfillStatus[]> =
    {
      REQUESTED: ["IN_PROGRESS", "FAILED", "CANCELLED"],
      IN_PROGRESS: ["COMPLETED", "FAILED", "CANCELLED"],
      COMPLETED: [],
      FAILED: [],
      CANCELLED: [],
    };
  if (!allowed[from].includes(to)) {
    throw new GlobalSyncBackfillError(
      "INVALID_TRANSITION",
      `Historical backfill cannot move from ${from} to ${to}`,
    );
  }
}

export interface HistoricalBackfillIdentity {
  requestId: string;
  policyRevision: number;
  from: string;
  to: string;
  batchRef: string;
}

export function isMatchingHistoricalBackfillCoverage(
  row: {
    agentId: string;
    status: GlobalSyncBackfillStatus;
    policyRevision: number;
    rangeFrom: string;
    rangeTo: string;
    linkedBatchId: string | null;
    linkedBatchRef: string;
  },
  input: HistoricalBackfillIdentity & { authenticatedAgentId: string },
): boolean {
  return Boolean(
    row.linkedBatchId &&
      row.agentId === input.authenticatedAgentId &&
      row.status === "COMPLETED" &&
      row.policyRevision === input.policyRevision &&
      row.rangeFrom === input.from &&
      row.rangeTo === input.to &&
      row.linkedBatchRef === input.batchRef,
  );
}

export interface RequestHistoricalBackfillInput {
  actorUserId: string;
  agentId: string;
  rangeFrom: string;
  rangeTo: string;
  reason: string;
  now?: Date;
  ip?: string | null;
}

export interface CompleteHistoricalBackfillInput extends HistoricalBackfillIdentity {
  agent: AuthenticatedAgent;
  recordsRead: number;
  recordsSent: number;
  reconciliationExpected: number;
  reconciliationCentral: number;
  reconciliationGap: number;
  resultMessage?: string | null;
  now?: Date;
}

export interface GlobalSyncBackfillServiceStore {
  request(
    input: RequestHistoricalBackfillInput,
  ): Promise<GlobalSyncBackfillRequestRecord>;
  cancel(input: {
    actorUserId: string;
    requestId: string;
    reason: string;
    now?: Date;
    ip?: string | null;
  }): Promise<void>;
  deliverForAgent(
    agentId: string,
  ): Promise<
    | (Omit<HistoricalBackfillIdentity, "batchRef"> & {
        batchRef: string | null;
      })
    | null
  >;
  start(
    input: HistoricalBackfillIdentity & {
      agent: AuthenticatedAgent;
      recordsRead: number;
      now?: Date;
    },
  ): Promise<{ batchId: string; resumed: boolean }>;
  complete(input: CompleteHistoricalBackfillInput): Promise<void>;
  reportTerminalFailure(
    input: HistoricalBackfillIdentity & {
      agent: AuthenticatedAgent;
      errorMessage: string;
      retryable: boolean;
      now?: Date;
    },
  ): Promise<void>;
  recordCoverage(
    input: HistoricalBackfillIdentity & {
      authenticatedAgentId: string;
      covered: number;
      unresolved: number;
    },
  ): Promise<boolean>;
}

function assertIdentity(
  row: typeof globalSyncBackfillRequests.$inferSelect,
  input: HistoricalBackfillIdentity & { agent: AuthenticatedAgent },
): void {
  if (
    row.agentId !== input.agent.agentId ||
    row.policyRevision !== input.policyRevision ||
    row.rangeFrom !== input.from ||
    row.rangeTo !== input.to
  ) {
    throw new GlobalSyncBackfillError(
      "BACKFILL_IDENTITY_CONFLICT",
      "Historical backfill identity does not match its authorization",
    );
  }
}

async function readLockedPolicy(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  const [setting] = await tx
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.settingKey, GLOBAL_SYNC_START_DATE_POLICY_KEY))
    .limit(1)
    .for("update");
  return setting ? parseGlobalSyncStartDatePolicy(setting.value) : null;
}

function assertCurrentPlan(
  policy: GlobalSyncStartDatePolicy | null,
  row: typeof globalSyncBackfillRequests.$inferSelect,
): void {
  const plan = policy?.backfillPlan;
  if (
    !policy?.activeDate ||
    policy.activeRevision !== row.policyRevision ||
    !plan ||
    plan.status !== "ACTIVE" ||
    plan.policyRevision !== row.policyRevision ||
    row.rangeFrom < plan.from ||
    row.rangeTo > plan.to
  ) {
    throw new GlobalSyncBackfillError(
      "BACKFILL_AUTHORIZATION_CLOSED",
      "Historical backfill is no longer authorized by the active plan",
    );
  }
}

const drizzleBackfillStore: GlobalSyncBackfillServiceStore = {
  async request(input) {
    return db.transaction(async (tx) => {
      const now = input.now ?? new Date();
      const policy = await readLockedPolicy(tx);
      const [[actor], [agent], open, activeBatches] = await Promise.all([
        tx
          .select({ id: users.id, role: users.role, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, input.actorUserId))
          .limit(1),
        tx
          .select({
            id: agents.id,
            facilityId: agents.facilityId,
            capabilities: agents.capabilities,
            appliedPolicyRevision: agents.globalSyncStartDateAppliedRevision,
            desiredSyncState: agents.syncControlState,
            effectiveSyncState: agents.effectiveSyncState,
            lastSeenAt: agents.lastSeenAt,
            queuePendingCount: agents.queuePendingCount,
            queueFailedCount: agents.queueFailedCount,
            queueTelemetryAt: agents.queueTelemetryAt,
            lastSyncAt: agents.lastSyncAt,
            syncRequestedAt: agents.syncRequestedAt,
            syncRequestedFrom: agents.syncRequestedFrom,
            syncRequestedTo: agents.syncRequestedTo,
          })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          .limit(1)
          .for("update"),
        tx
          .select({ id: globalSyncBackfillRequests.id })
          .from(globalSyncBackfillRequests)
          .where(
            inArray(globalSyncBackfillRequests.status, [
              "REQUESTED",
              "IN_PROGRESS",
            ]),
          )
          .for("update"),
        tx
          .select({ id: syncBatches.id })
          .from(syncBatches)
          .where(
            and(
              eq(syncBatches.agentId, input.agentId),
              inArray(syncBatches.status, ["STARTED", "UPLOADING"]),
            ),
          )
          .limit(1),
      ]);
      if (!agent)
        throw new GlobalSyncBackfillError("AGENT_NOT_FOUND", "Agent not found");
      const capabilities = parseCapabilities(agent.capabilities);
      const eligibility: BackfillEligibilityInput = {
        actor: {
          id: actor?.id ?? input.actorUserId,
          role: actor?.role ?? "",
          isActive: Boolean(actor?.isActive),
        },
        agent: {
          id: agent.id,
          facilityId: agent.facilityId,
          online: Boolean(
            agent.lastSeenAt &&
            now.getTime() - agent.lastSeenAt.getTime() <= 5 * 60_000,
          ),
          capabilities: {
            remoteSyncStartDate: capabilities.remoteSyncStartDate,
            idempotentUploadChunk: capabilities.idempotentUploadChunk,
          },
          appliedPolicyRevision: agent.appliedPolicyRevision,
          desiredSyncState: agent.desiredSyncState,
          effectiveSyncState: agent.effectiveSyncState,
          queuePendingCount: agent.queuePendingCount,
          queueFailedCount: agent.queueFailedCount,
          queueTelemetryAt: agent.queueTelemetryAt,
        },
        policy,
        rangeFrom: input.rangeFrom,
        rangeTo: input.rangeTo,
        reason: input.reason,
        hasOpenRequest: open.length > 0,
        hasActiveBatch: activeBatches.length > 0,
        hasManualRequest: Boolean(
          agent.syncRequestedFrom ||
          agent.syncRequestedTo ||
          (agent.syncRequestedAt &&
            (!agent.lastSyncAt ||
              agent.syncRequestedAt.getTime() > agent.lastSyncAt.getTime())),
        ),
        now,
      };
      const built = buildBackfillRequest(eligibility, newId());
      await tx.insert(globalSyncBackfillRequests).values(built);
      await tx
        .update(agents)
        .set({
          syncRequestedAt: now,
          syncRequestedFrom: built.rangeFrom,
          syncRequestedTo: built.rangeTo,
        })
        .where(eq(agents.id, built.agentId));
      await tx.insert(auditLogs).values({
        actorType: "USER",
        actorId: actor!.id,
        action: "GLOBAL_SYNC_BACKFILL_REQUESTED",
        resource: "global_sync_backfill_request",
        resourceId: built.id,
        facilityId: built.facilityId,
        ip: input.ip ?? null,
        metadata: {
          agentId: built.agentId,
          policyRevision: built.policyRevision,
          from: built.rangeFrom,
          to: built.rangeTo,
          reason: built.reason,
        },
      });
      return built;
    });
  },

  async cancel(input) {
    await db.transaction(async (tx) => {
      const now = input.now ?? new Date();
      await readLockedPolicy(tx);
      const [[actor], [row]] = await Promise.all([
        tx
          .select({ id: users.id, role: users.role, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, input.actorUserId))
          .limit(1),
        tx
          .select()
          .from(globalSyncBackfillRequests)
          .where(eq(globalSyncBackfillRequests.id, input.requestId))
          .limit(1)
          .for("update"),
      ]);
      if (!actor?.isActive || actor.role !== "SUPER_ADMIN")
        throw new GlobalSyncBackfillError(
          "FORBIDDEN",
          "Only an active SUPER_ADMIN may cancel historical backfill",
        );
      if (!row)
        throw new GlobalSyncBackfillError(
          "REQUEST_NOT_FOUND",
          "Historical backfill request not found",
        );
      assertBackfillTransition(row.status, "CANCELLED");
      const reason = input.reason.trim().slice(0, 500);
      if (!reason)
        throw new GlobalSyncBackfillError(
          "REASON_REQUIRED",
          "Cancellation reason is required",
        );
      await tx
        .update(globalSyncBackfillRequests)
        .set({ status: "CANCELLED", cancelledAt: now, resultMessage: reason })
        .where(eq(globalSyncBackfillRequests.id, row.id));
      await tx
        .update(agents)
        .set({
          syncRequestedAt: null,
          syncRequestedFrom: null,
          syncRequestedTo: null,
        })
        .where(
          and(
            eq(agents.id, row.agentId),
            eq(agents.syncRequestedFrom, row.rangeFrom),
            eq(agents.syncRequestedTo, row.rangeTo),
          ),
        );
      await tx
        .insert(auditLogs)
        .values({
          actorType: "USER",
          actorId: actor.id,
          action: "GLOBAL_SYNC_BACKFILL_CANCELLED",
          resource: "global_sync_backfill_request",
          resourceId: row.id,
          facilityId: row.facilityId,
          ip: input.ip ?? null,
          metadata: { reason },
        });
    });
  },

  async deliverForAgent(agentId) {
    const [row] = await db
      .select()
      .from(globalSyncBackfillRequests)
      .where(
        and(
          eq(globalSyncBackfillRequests.agentId, agentId),
          inArray(globalSyncBackfillRequests.status, [
            "REQUESTED",
            "IN_PROGRESS",
          ]),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [setting] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.settingKey, GLOBAL_SYNC_START_DATE_POLICY_KEY))
      .limit(1);
    try {
      assertCurrentPlan(
        setting ? parseGlobalSyncStartDatePolicy(setting.value) : null,
        row,
      );
    } catch {
      return null;
    }
    let batchRef: string | null = null;
    if (row.linkedBatchId) {
      const [batch] = await db
        .select({ batchRef: syncBatches.batchRef })
        .from(syncBatches)
        .where(eq(syncBatches.id, row.linkedBatchId))
        .limit(1);
      batchRef = batch?.batchRef ?? null;
    }
    return {
      requestId: row.id,
      policyRevision: row.policyRevision,
      from: row.rangeFrom,
      to: row.rangeTo,
      batchRef,
    };
  },

  async start(input) {
    return db.transaction(async (tx) => {
      const now = input.now ?? new Date();
      const policy = await readLockedPolicy(tx);
      const [row] = await tx
        .select()
        .from(globalSyncBackfillRequests)
        .where(eq(globalSyncBackfillRequests.id, input.requestId))
        .limit(1)
        .for("update");
      if (!row)
        throw new GlobalSyncBackfillError(
          "REQUEST_NOT_FOUND",
          "Historical backfill request not found",
        );
      assertIdentity(row, input);
      assertCurrentPlan(policy, row);
      if (
        !(["REQUESTED", "IN_PROGRESS"] as const).includes(
          row.status as "REQUESTED" | "IN_PROGRESS",
        )
      )
        throw new GlobalSyncBackfillError(
          "BACKFILL_AUTHORIZATION_CLOSED",
          "Historical backfill request is terminal",
        );
      if (row.linkedBatchId) {
        const [linked] = await tx
          .select({ id: syncBatches.id, batchRef: syncBatches.batchRef })
          .from(syncBatches)
          .where(eq(syncBatches.id, row.linkedBatchId))
          .limit(1);
        if (!linked || linked.batchRef !== input.batchRef)
          throw new GlobalSyncBackfillError(
            "BATCH_CONFLICT",
            "Historical request is linked to a different batch",
          );
        return { batchId: linked.id, resumed: true };
      }
      const [existing] = await tx
        .select({
          id: syncBatches.id,
          mode: syncBatches.mode,
          rangeFrom: syncBatches.rangeFrom,
          rangeTo: syncBatches.rangeTo,
        })
        .from(syncBatches)
        .where(
          and(
            eq(syncBatches.agentId, input.agent.agentId),
            eq(syncBatches.batchRef, input.batchRef),
          ),
        )
        .limit(1);
      if (
        existing &&
        (existing.mode !== "MANUAL_RANGE" ||
          existing.rangeFrom !== input.from ||
          existing.rangeTo !== input.to)
      ) {
        throw new GlobalSyncBackfillError(
          "BATCH_CONFLICT",
          "Existing batch does not match historical authorization",
        );
      }
      const batchId = existing?.id ?? newId();
      if (!existing)
        await tx
          .insert(syncBatches)
          .values({
            id: batchId,
            batchRef: input.batchRef,
            agentId: input.agent.agentId,
            facilityId: input.agent.facilityId,
            mode: "MANUAL_RANGE",
            status: "STARTED",
            rangeFrom: input.from,
            rangeTo: input.to,
            startedAt: now,
            recordsRead: input.recordsRead,
          });
      await tx
        .update(globalSyncBackfillRequests)
        .set({
          status: "IN_PROGRESS",
          linkedBatchId: batchId,
          startedAt: row.startedAt ?? now,
        })
        .where(eq(globalSyncBackfillRequests.id, row.id));
      await tx
        .update(agents)
        .set({ status: "SYNCING", lastSyncAt: now })
        .where(eq(agents.id, row.agentId));
      await tx
        .insert(auditLogs)
        .values({
          actorType: "AGENT",
          actorId: row.agentId,
          action: "GLOBAL_SYNC_BACKFILL_STARTED",
          resource: "global_sync_backfill_request",
          resourceId: row.id,
          facilityId: row.facilityId,
          metadata: {
            batchRef: input.batchRef,
            policyRevision: row.policyRevision,
            from: row.rangeFrom,
            to: row.rangeTo,
          },
        });
      return { batchId, resumed: Boolean(existing) };
    });
  },

  async complete(input) {
    if (
      input.reconciliationGap !== 0 ||
      input.reconciliationExpected !== input.reconciliationCentral
    )
      throw new GlobalSyncBackfillError(
        "RECONCILIATION_GAP",
        "Historical completion requires reconciliation gap zero",
      );
    await db.transaction(async (tx) => {
      const now = input.now ?? new Date();
      const policy = await readLockedPolicy(tx);
      const [row] = await tx
        .select()
        .from(globalSyncBackfillRequests)
        .where(eq(globalSyncBackfillRequests.id, input.requestId))
        .limit(1)
        .for("update");
      if (!row)
        throw new GlobalSyncBackfillError(
          "REQUEST_NOT_FOUND",
          "Historical backfill request not found",
        );
      assertIdentity(row, input);
      assertCurrentPlan(policy, row);
      if (row.status === "COMPLETED") return;
      assertBackfillTransition(row.status, "COMPLETED");
      const [batch] = row.linkedBatchId
        ? await tx
            .select({ id: syncBatches.id, batchRef: syncBatches.batchRef })
            .from(syncBatches)
            .where(eq(syncBatches.id, row.linkedBatchId))
            .limit(1)
        : [];
      if (!batch || batch.batchRef !== input.batchRef)
        throw new GlobalSyncBackfillError(
          "BATCH_CONFLICT",
          "Historical batch does not match request",
        );
      await tx
        .update(syncBatches)
        .set({
          status: "COMPLETED",
          completedAt: now,
          recordsRead: input.recordsRead,
        })
        .where(eq(syncBatches.id, batch.id));
      await tx
        .update(globalSyncBackfillRequests)
        .set({
          status: "COMPLETED",
          completedAt: now,
          reconciliationExpected: input.reconciliationExpected,
          reconciliationCentral: input.reconciliationCentral,
          reconciliationGap: 0,
          resultMessage: input.resultMessage?.slice(0, 500) ?? null,
        })
        .where(eq(globalSyncBackfillRequests.id, row.id));
      await tx
        .update(agents)
        .set({
          status: "ONLINE",
          lastSuccessfulSyncAt: now,
          lastSyncAt: now,
          syncCount: sql`${agents.syncCount} + 1`,
          lastError: null,
          syncRequestedAt: null,
          syncRequestedFrom: null,
          syncRequestedTo: null,
        })
        .where(eq(agents.id, row.agentId));
      await tx
        .insert(auditLogs)
        .values({
          actorType: "AGENT",
          actorId: row.agentId,
          action: "GLOBAL_SYNC_BACKFILL_COMPLETED",
          resource: "global_sync_backfill_request",
          resourceId: row.id,
          facilityId: row.facilityId,
          metadata: {
            batchRef: input.batchRef,
            reconciliationExpected: input.reconciliationExpected,
            reconciliationCentral: input.reconciliationCentral,
            reconciliationGap: 0,
          },
        });
    });
  },

  async reportTerminalFailure(input) {
    if (input.retryable) return;
    await db.transaction(async (tx) => {
      const now = input.now ?? new Date();
      await readLockedPolicy(tx);
      const [row] = await tx
        .select()
        .from(globalSyncBackfillRequests)
        .where(eq(globalSyncBackfillRequests.id, input.requestId))
        .limit(1)
        .for("update");
      if (!row)
        throw new GlobalSyncBackfillError(
          "REQUEST_NOT_FOUND",
          "Historical backfill request not found",
        );
      assertIdentity(row, input);
      if (row.status === "FAILED") return;
      assertBackfillTransition(row.status, "FAILED");
      if (row.linkedBatchId)
        await tx
          .update(syncBatches)
          .set({
            status: "FAILED",
            completedAt: now,
            errorMessage: input.errorMessage.slice(0, 2000),
          })
          .where(eq(syncBatches.id, row.linkedBatchId));
      await tx
        .update(globalSyncBackfillRequests)
        .set({
          status: "FAILED",
          failedAt: now,
          errorMessage: input.errorMessage.slice(0, 2000),
        })
        .where(eq(globalSyncBackfillRequests.id, row.id));
      await tx
        .update(agents)
        .set({
          status: "ERROR",
          failedCount: sql`${agents.failedCount} + 1`,
          lastError: input.errorMessage.slice(0, 2000),
          lastErrorAt: now,
          syncRequestedAt: null,
          syncRequestedFrom: null,
          syncRequestedTo: null,
        })
        .where(eq(agents.id, row.agentId));
      await tx
        .insert(auditLogs)
        .values({
          actorType: "AGENT",
          actorId: row.agentId,
          action: "GLOBAL_SYNC_BACKFILL_FAILED",
          resource: "global_sync_backfill_request",
          resourceId: row.id,
          facilityId: row.facilityId,
          metadata: {
            batchRef: input.batchRef,
            error: input.errorMessage.slice(0, 500),
          },
        });
    });
  },

  async recordCoverage(input) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          agentId: globalSyncBackfillRequests.agentId,
          status: globalSyncBackfillRequests.status,
          policyRevision: globalSyncBackfillRequests.policyRevision,
          rangeFrom: globalSyncBackfillRequests.rangeFrom,
          rangeTo: globalSyncBackfillRequests.rangeTo,
          linkedBatchId: globalSyncBackfillRequests.linkedBatchId,
          linkedBatchRef: syncBatches.batchRef,
          quarantineCovered: globalSyncBackfillRequests.quarantineCovered,
          quarantineUnresolved: globalSyncBackfillRequests.quarantineUnresolved,
        })
        .from(globalSyncBackfillRequests)
        .innerJoin(syncBatches, eq(syncBatches.id, globalSyncBackfillRequests.linkedBatchId))
        .where(eq(globalSyncBackfillRequests.id, input.requestId))
        .limit(1)
        .for("update");
      if (!row || !isMatchingHistoricalBackfillCoverage(row, input)) return false;
      if (
        row.quarantineCovered === input.covered &&
        row.quarantineUnresolved === input.unresolved
      ) return true;
      if (row.quarantineCovered !== null || row.quarantineUnresolved !== null) {
        return false;
      }
      await tx
        .update(globalSyncBackfillRequests)
        .set({ quarantineCovered: input.covered, quarantineUnresolved: input.unresolved })
        .where(eq(globalSyncBackfillRequests.id, input.requestId));
      return true;
    });
  },
};

export function createGlobalSyncBackfillService(
  store: GlobalSyncBackfillServiceStore = drizzleBackfillStore,
) {
  return {
    request: store.request.bind(store),
    cancel: store.cancel.bind(store),
    deliverForAgent: store.deliverForAgent.bind(store),
    start: store.start.bind(store),
    complete: store.complete.bind(store),
    reportTerminalFailure: store.reportTerminalFailure.bind(store),
    recordCoverage: store.recordCoverage.bind(store),
  };
}

export const globalSyncBackfillService = createGlobalSyncBackfillService();
