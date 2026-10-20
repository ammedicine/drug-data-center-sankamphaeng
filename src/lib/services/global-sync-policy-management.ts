import { eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, auditLogs, syncBatches, systemSettings, users } from "@/lib/db/schema";
import { parseCapabilities } from "@/lib/shared/agent-build";

import {
  GLOBAL_SYNC_START_DATE_POLICY_KEY,
  globalSyncStartDateIsoDateSchema,
  parseGlobalSyncStartDatePolicy,
  type GlobalSyncStartDatePolicy,
} from "./global-sync-policy";

export type GlobalSyncStartDateReadinessStatus = "APPLIED" | "PENDING" | "UNSUPPORTED";

export interface ManagedGlobalSyncStartDateAgent {
  agentId: string;
  supportsRemoteSyncStartDate: boolean;
  appliedRevision: number | null;
  syncControlState: "RUNNING" | "PAUSED";
}

export function globalSyncStartDateReadiness(
  policy: GlobalSyncStartDatePolicy,
  rows: ManagedGlobalSyncStartDateAgent[],
): Array<{ agentId: string; status: GlobalSyncStartDateReadinessStatus }> {
  return rows.map((row) => ({
    agentId: row.agentId,
    status: !row.supportsRemoteSyncStartDate
      ? "UNSUPPORTED"
      : (row.appliedRevision ?? 0) >= policy.desiredRevision
        ? "APPLIED"
        : "PENDING",
  }));
}

export class GlobalSyncStartDateManagementError extends Error {
  constructor(
    readonly code:
      | "FORBIDDEN"
      | "POLICY_MISSING"
      | "REVISION_CONFLICT"
      | "ACTIVE_BATCH"
      | "FLEET_NOT_READY"
      | "OVERRIDE_REASON_REQUIRED"
      | "OVERRIDE_REQUIRES_PAUSE",
    message: string,
  ) {
    super(message);
    this.name = "GlobalSyncStartDateManagementError";
  }
}

export interface GlobalSyncStartDateManagementActor {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
}

export interface GlobalSyncStartDateAuditEntry {
  action: string;
  metadata: Record<string, unknown>;
  ip?: string | null;
}

export interface LockedGlobalSyncStartDateManagement {
  actor: GlobalSyncStartDateManagementActor | null;
  policy: GlobalSyncStartDatePolicy | null;
  agents: ManagedGlobalSyncStartDateAgent[];
  hasActiveBatch: boolean;
  savePolicy(policy: GlobalSyncStartDatePolicy): Promise<void>;
  writeAudit(entry: GlobalSyncStartDateAuditEntry): Promise<void>;
}

export interface GlobalSyncStartDateManagementStore {
  withLock<T>(
    actorUserId: string,
    work: (locked: LockedGlobalSyncStartDateManagement) => Promise<T>,
  ): Promise<T>;
}

const drizzleManagementStore: GlobalSyncStartDateManagementStore = {
  async withLock(actorUserId, work) {
    return db.transaction(async (tx) => {
      const [actor] = await tx
        .select({ id: users.id, email: users.email, role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, actorUserId))
        .limit(1);
      const [setting] = await tx
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, GLOBAL_SYNC_START_DATE_POLICY_KEY))
        .limit(1)
        .for("update");
      const agentRows = await tx
        .select({
          agentId: agents.id,
          capabilities: agents.capabilities,
          appliedRevision: agents.globalSyncStartDateAppliedRevision,
          syncControlState: agents.syncControlState,
        })
        .from(agents);
      const batchRows = await tx
        .select({
          recordsRead: syncBatches.recordsRead,
          recordsAccepted: syncBatches.recordsAccepted,
          recordsRejected: syncBatches.recordsRejected,
          startedAt: syncBatches.startedAt,
          updatedAt: syncBatches.updatedAt,
        })
        .from(syncBatches)
        .where(inArray(syncBatches.status, ["STARTED", "UPLOADING"]));

      const cutoff = Date.now() - 30 * 60_000;
      const hasActiveBatch = batchRows.some((batch) => {
        const completed = batch.recordsAccepted + batch.recordsRejected >= batch.recordsRead && batch.recordsRead > 0;
        const heardAt = (batch.updatedAt ?? batch.startedAt)?.getTime() ?? 0;
        return !completed && heardAt >= cutoff;
      });
      const managedAgents = agentRows.map((row) => ({
        agentId: row.agentId,
        supportsRemoteSyncStartDate: parseCapabilities(row.capabilities).remoteSyncStartDate,
        appliedRevision: row.appliedRevision,
        syncControlState: row.syncControlState,
      }));
      const policy = setting ? parseGlobalSyncStartDatePolicy(setting.value) : null;

      return work({
        actor: actor ?? null,
        policy,
        agents: managedAgents,
        hasActiveBatch,
        savePolicy: async (next) => {
          if (setting) {
            await tx
              .update(systemSettings)
              .set({ value: next })
              .where(eq(systemSettings.settingKey, GLOBAL_SYNC_START_DATE_POLICY_KEY));
          } else {
            await tx.insert(systemSettings).values({
              settingKey: GLOBAL_SYNC_START_DATE_POLICY_KEY,
              value: next,
              description: "District-wide desired and active sync start date policy",
            });
          }
        },
        writeAudit: async (entry) => {
          await tx.insert(auditLogs).values({
            actorType: "USER",
            actorId: actor?.id ?? actorUserId,
            actorLabel: actor?.email ?? null,
            action: entry.action,
            resource: "system_setting",
            resourceId: GLOBAL_SYNC_START_DATE_POLICY_KEY,
            ip: entry.ip ?? null,
            metadata: entry.metadata,
          });
        },
      });
    });
  },
};

function requireSuperAdmin(
  actor: GlobalSyncStartDateManagementActor | null,
): asserts actor is GlobalSyncStartDateManagementActor {
  if (!actor || !actor.isActive || actor.role !== "SUPER_ADMIN") {
    throw new GlobalSyncStartDateManagementError(
      "FORBIDDEN",
      "เฉพาะผู้ดูแลระบบส่วนกลางที่ยังใช้งานอยู่เท่านั้น",
    );
  }
}

export function createGlobalSyncStartDateManagementService(
  store: GlobalSyncStartDateManagementStore = drizzleManagementStore,
) {
  return {
    async saveDesired(input: {
      actorUserId: string;
      desiredDate: string;
      expectedDesiredRevision: number;
      now?: Date;
      ip?: string | null;
    }): Promise<GlobalSyncStartDatePolicy> {
      const desiredDate = globalSyncStartDateIsoDateSchema.parse(input.desiredDate);
      return store.withLock(input.actorUserId, async (locked) => {
        requireSuperAdmin(locked.actor);
        const current = locked.policy;
        if (current?.desiredDate === desiredDate) return current;
        const actualRevision = current?.desiredRevision ?? 0;
        if (input.expectedDesiredRevision !== actualRevision) {
          throw new GlobalSyncStartDateManagementError(
            "REVISION_CONFLICT",
            "นโยบายถูกแก้ไขโดยผู้ใช้อื่น กรุณาโหลดหน้าใหม่",
          );
        }
        const next = parseGlobalSyncStartDatePolicy({
          schemaVersion: 1,
          desiredDate,
          desiredRevision: actualRevision + 1,
          activeDate: current?.activeDate ?? null,
          activeRevision: current?.activeRevision ?? 0,
          updatedBy: locked.actor.id,
          updatedAt: (input.now ?? new Date()).toISOString(),
          ...(current?.backfillPlan ? { backfillPlan: current.backfillPlan } : {}),
        });
        await locked.savePolicy(next);
        await locked.writeAudit({
          action: "GLOBAL_SYNC_START_DATE_DESIRED_SET",
          ip: input.ip,
          metadata: {
            previousDesiredDate: current?.desiredDate ?? null,
            previousDesiredRevision: actualRevision,
            desiredDate: next.desiredDate,
            desiredRevision: next.desiredRevision,
          },
        });
        return next;
      });
    },

    async activateDesired(input: {
      actorUserId: string;
      expectedDesiredRevision: number;
      overridePending: boolean;
      overrideReason: string | null;
      now?: Date;
      ip?: string | null;
    }): Promise<GlobalSyncStartDatePolicy> {
      return store.withLock(input.actorUserId, async (locked) => {
        requireSuperAdmin(locked.actor);
        const current = locked.policy;
        if (!current) {
          throw new GlobalSyncStartDateManagementError("POLICY_MISSING", "ยังไม่มีนโยบายให้เปิดใช้");
        }
        if (input.expectedDesiredRevision !== current.desiredRevision) {
          throw new GlobalSyncStartDateManagementError(
            "REVISION_CONFLICT",
            "นโยบายถูกแก้ไขโดยผู้ใช้อื่น กรุณาโหลดหน้าใหม่",
          );
        }
        if (current.activeRevision === current.desiredRevision) return current;
        if (locked.hasActiveBatch) {
          throw new GlobalSyncStartDateManagementError(
            "ACTIVE_BATCH",
            "ยังมีชุดข้อมูลที่กำลังทำงานอยู่ กรุณารอให้จบก่อนเปิดใช้",
          );
        }

        const readiness = globalSyncStartDateReadiness(current, locked.agents);
        const outstanding = readiness.filter((row) => row.status !== "APPLIED");
        const reason = input.overrideReason?.trim().slice(0, 500) || null;
        if (outstanding.length) {
          if (!input.overridePending) {
            throw new GlobalSyncStartDateManagementError(
              "FLEET_NOT_READY",
              "ยังมี Agent ที่ยังไม่รับนโยบาย",
            );
          }
          if (!reason) {
            throw new GlobalSyncStartDateManagementError(
              "OVERRIDE_REASON_REQUIRED",
              "การข้าม Agent ที่ยังไม่พร้อมต้องระบุเหตุผล",
            );
          }
          const outstandingIds = new Set(outstanding.map((row) => row.agentId));
          if (
            locked.agents.some(
              (row) => outstandingIds.has(row.agentId) && row.syncControlState !== "PAUSED",
            )
          ) {
            throw new GlobalSyncStartDateManagementError(
              "OVERRIDE_REQUIRES_PAUSE",
              "Agent ที่ยังไม่พร้อมทุกเครื่องต้องถูกหยุดจากศูนย์กลางก่อน",
            );
          }
        }

        const next = parseGlobalSyncStartDatePolicy({
          ...current,
          activeDate: current.desiredDate,
          activeRevision: current.desiredRevision,
          updatedBy: locked.actor.id,
          updatedAt: (input.now ?? new Date()).toISOString(),
        });
        await locked.savePolicy(next);
        await locked.writeAudit({
          action: outstanding.length
            ? "GLOBAL_SYNC_START_DATE_ACTIVATED_OVERRIDE"
            : "GLOBAL_SYNC_START_DATE_ACTIVATED",
          ip: input.ip,
          metadata: {
            previousActiveDate: current.activeDate,
            previousActiveRevision: current.activeRevision,
            activeDate: next.activeDate,
            activeRevision: next.activeRevision,
            reason,
            overriddenAgentIds: outstanding.map((row) => row.agentId),
          },
        });
        return next;
      });
    },
  };
}

export const globalSyncStartDateManagementService =
  createGlobalSyncStartDateManagementService();
