import { and, eq, gt, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, auditLogs, facilities, syncBatches, users } from "@/lib/db/schema";

export const APPROVED_STALE_BATCH_REF = "SYNC-20261007-000158";
export const APPROVED_STALE_BATCH_FACILITY = "05957";
export const STALE_BATCH_ABANDONED_MESSAGE =
  "Legacy batch abandoned; completion evidence unavailable and reconstruction unsafe.";

const STALE_AFTER_MS = 30 * 60_000;

type BatchStatus = "STARTED" | "UPLOADING" | "COMPLETED" | "FAILED" | "ABORTED";

export class StaleSyncBatchAbandonmentError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "WRONG_BATCH" | "REASON_REQUIRED" | "NOT_ELIGIBLE" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "StaleSyncBatchAbandonmentError";
  }
}

export interface StaleSyncBatchAbandonmentActor {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
}

export interface StaleSyncBatchRecord {
  id: string;
  batchRef: string;
  agentId: string;
  facilityId: string;
  facilityPcucode: string;
  status: BatchStatus;
  completedAt: Date | null;
  recordsRead: number;
  recordsSent: number;
  recordsAccepted: number;
  recordsRejected: number;
  startedAt: Date;
  updatedAt: Date | null;
  hasNewerCompletedBatch: boolean;
  errorMessage?: string | null;
}

export interface StaleSyncBatchAbandonmentAuditEntry {
  action: "SYNC_BATCH_ABANDONED";
  resourceId: string;
  facilityId: string;
  ip?: string | null;
  metadata: Record<string, unknown>;
}

export interface LockedStaleSyncBatchAbandonment {
  actor: StaleSyncBatchAbandonmentActor | null;
  batches: StaleSyncBatchRecord[];
  transitionToAborted(
    expected: StaleSyncBatchRecord,
    closedAt: Date,
    errorMessage: string,
  ): Promise<boolean>;
  writeAudit(entry: StaleSyncBatchAbandonmentAuditEntry): Promise<void>;
}

export interface StaleSyncBatchAbandonmentStore {
  withTransaction<T>(
    actorUserId: string,
    batchRef: string,
    work: (locked: LockedStaleSyncBatchAbandonment) => Promise<T>,
  ): Promise<T>;
}

function affectedRows(result: unknown): number {
  return Number((result as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
}

const drizzleStore: StaleSyncBatchAbandonmentStore = {
  async withTransaction(actorUserId, batchRef, work) {
    return db.transaction(async (tx) => {
      const [actor] = await tx
        .select({ id: users.id, email: users.email, role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, actorUserId))
        .limit(1)
        .for("update");

      const rows = await tx
        .select({
          id: syncBatches.id,
          batchRef: syncBatches.batchRef,
          agentId: syncBatches.agentId,
          facilityId: syncBatches.facilityId,
          facilityPcucode: facilities.jhcisPcucode,
          status: syncBatches.status,
          completedAt: syncBatches.completedAt,
          recordsRead: syncBatches.recordsRead,
          recordsSent: syncBatches.recordsSent,
          recordsAccepted: syncBatches.recordsAccepted,
          recordsRejected: syncBatches.recordsRejected,
          startedAt: syncBatches.startedAt,
          updatedAt: syncBatches.updatedAt,
        })
        .from(syncBatches)
        .innerJoin(
          agents,
          and(eq(syncBatches.agentId, agents.id), eq(syncBatches.facilityId, agents.facilityId)),
        )
        .innerJoin(facilities, eq(syncBatches.facilityId, facilities.id))
        .where(eq(syncBatches.batchRef, batchRef))
        .limit(2)
        .for("update");

      const batches: StaleSyncBatchRecord[] = [];
      for (const row of rows) {
        const [newer] = await tx
          .select({ id: syncBatches.id })
          .from(syncBatches)
          .where(
            and(
              eq(syncBatches.agentId, row.agentId),
              eq(syncBatches.status, "COMPLETED"),
              gt(syncBatches.startedAt, row.startedAt),
            ),
          )
          .limit(1);
        batches.push({ ...row, hasNewerCompletedBatch: Boolean(newer) });
      }

      return work({
        actor: actor ?? null,
        batches,
        transitionToAborted: async (expected, closedAt, errorMessage) => {
          const result = await tx
            .update(syncBatches)
            .set({ status: "ABORTED", completedAt: closedAt, errorMessage })
            .where(
              and(
                eq(syncBatches.id, expected.id),
                eq(syncBatches.batchRef, expected.batchRef),
                eq(syncBatches.agentId, expected.agentId),
                eq(syncBatches.facilityId, expected.facilityId),
                eq(syncBatches.status, expected.status),
                isNull(syncBatches.completedAt),
              ),
            );
          return affectedRows(result) === 1;
        },
        writeAudit: async (entry) => {
          await tx.insert(auditLogs).values({
            actorType: "USER",
            actorId: actor?.id ?? actorUserId,
            actorLabel: actor?.email ?? null,
            action: entry.action,
            resource: "sync_batch",
            resourceId: entry.resourceId,
            facilityId: entry.facilityId,
            ip: entry.ip ?? null,
            metadata: entry.metadata,
          });
        },
      });
    });
  },
};

function requireActiveSuperAdmin(
  actor: StaleSyncBatchAbandonmentActor | null,
): asserts actor is StaleSyncBatchAbandonmentActor {
  if (!actor || !actor.isActive || actor.role !== "SUPER_ADMIN") {
    throw new StaleSyncBatchAbandonmentError(
      "FORBIDDEN",
      "เฉพาะผู้ดูแลระบบส่วนกลางที่ยังใช้งานอยู่เท่านั้น",
    );
  }
}

export function createStaleSyncBatchAbandonmentService(
  store: StaleSyncBatchAbandonmentStore = drizzleStore,
) {
  return {
    async abandon(input: {
      actorUserId: string;
      batchRef: string;
      reason: string;
      now?: Date;
      ip?: string | null;
    }) {
      const now = input.now ?? new Date();

      return store.withTransaction(input.actorUserId, input.batchRef, async (locked) => {
        requireActiveSuperAdmin(locked.actor);
        if (input.batchRef !== APPROVED_STALE_BATCH_REF) {
          throw new StaleSyncBatchAbandonmentError(
            "WRONG_BATCH",
            "batchRef ไม่ตรงกับ legacy batch ที่ได้รับอนุมัติ",
          );
        }
        const reason = input.reason.trim().slice(0, 500);
        if (!reason) {
          throw new StaleSyncBatchAbandonmentError(
            "REASON_REQUIRED",
            "ต้องระบุเหตุผลการปิด legacy batch",
          );
        }
        if (locked.batches.length !== 1) {
          throw new StaleSyncBatchAbandonmentError(
            "NOT_ELIGIBLE",
            "ไม่พบ legacy batch เป้าหมายแบบเอกเทศ",
          );
        }
        const batch = locked.batches[0];
        const lastActivityAt = batch.updatedAt ?? batch.startedAt;
        if (
          batch.batchRef !== APPROVED_STALE_BATCH_REF ||
          batch.facilityPcucode !== APPROVED_STALE_BATCH_FACILITY ||
          batch.status !== "UPLOADING" ||
          batch.completedAt !== null ||
          batch.recordsRead !== 379 ||
          batch.recordsSent !== 379 ||
          batch.recordsAccepted !== 379 ||
          batch.recordsRejected !== 0 ||
          now.getTime() - lastActivityAt.getTime() < STALE_AFTER_MS ||
          !batch.hasNewerCompletedBatch
        ) {
          throw new StaleSyncBatchAbandonmentError(
            "NOT_ELIGIBLE",
            "legacy batch ไม่อยู่ในสถานะ stale/open ที่อนุมัติ",
          );
        }

        const changed = await locked.transitionToAborted(
          batch,
          now,
          STALE_BATCH_ABANDONED_MESSAGE,
        );
        if (!changed) {
          throw new StaleSyncBatchAbandonmentError(
            "CONFLICT",
            "สถานะ batch เปลี่ยนระหว่างการตรวจสอบ กรุณาตรวจสอบใหม่",
          );
        }

        await locked.writeAudit({
          action: "SYNC_BATCH_ABANDONED",
          resourceId: batch.id,
          facilityId: batch.facilityId,
          ip: input.ip,
          metadata: {
            batchRef: batch.batchRef,
            agentId: batch.agentId,
            facilityId: batch.facilityId,
            previousStatus: batch.status,
            newStatus: "ABORTED",
            recordsRead: batch.recordsRead,
            recordsSent: batch.recordsSent,
            recordsAccepted: batch.recordsAccepted,
            recordsRejected: batch.recordsRejected,
            reason,
            timestamp: now.toISOString(),
          },
        });

        return {
          batchRef: batch.batchRef,
          agentId: batch.agentId,
          facilityId: batch.facilityId,
          previousStatus: batch.status,
          newStatus: "ABORTED" as const,
        };
      });
    },
  };
}

export const staleSyncBatchAbandonmentService = createStaleSyncBatchAbandonmentService();
