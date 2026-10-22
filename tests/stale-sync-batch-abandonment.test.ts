import { describe, expect, it } from "vitest";

import {
  APPROVED_STALE_BATCH_REF,
  STALE_BATCH_ABANDONED_MESSAGE,
  createStaleSyncBatchAbandonmentService,
  type LockedStaleSyncBatchAbandonment,
  type StaleSyncBatchRecord,
  type StaleSyncBatchAbandonmentStore,
} from "@/lib/services/stale-sync-batch-abandonment";

const now = new Date("2026-10-22T12:00:00.000Z");

function batch(): StaleSyncBatchRecord {
  return {
    id: "batch-legacy-1",
    batchRef: APPROVED_STALE_BATCH_REF,
    agentId: "agent-05957",
    facilityId: "facility-05957",
    facilityPcucode: "05957",
    status: "UPLOADING",
    completedAt: null,
    recordsRead: 379,
    recordsSent: 379,
    recordsAccepted: 379,
    recordsRejected: 0,
    startedAt: new Date("2026-10-07T01:00:00.000Z"),
    updatedAt: new Date("2026-10-07T01:05:00.000Z"),
    hasNewerCompletedBatch: true,
  };
}

class MemoryStore implements StaleSyncBatchAbandonmentStore {
  actor = { id: "super-1", email: "owner@example.test", role: "SUPER_ADMIN", isActive: true };
  matches: StaleSyncBatchRecord[] = [batch()];
  audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  concurrentStatus: "COMPLETED" | null = null;
  agent = {
    status: "ONLINE",
    syncCount: 194,
    failedCount: 0,
    lastSyncAt: new Date("2026-10-22T10:00:00.000Z"),
    lastSuccessfulSyncAt: new Date("2026-10-22T10:00:00.000Z"),
  };
  centralWatermark = "2026-10-22";
  drugUsage = [{ id: 1, syncBatchId: "newer-batch" }];
  newerBatches = [{ id: "newer-batch", status: "COMPLETED" }];

  async withTransaction<T>(
    _actorUserId: string,
    _batchRef: string,
    work: (locked: LockedStaleSyncBatchAbandonment) => Promise<T>,
  ): Promise<T> {
    return work({
      actor: this.actor,
      batches: this.matches,
      transitionToAborted: async (expected, closedAt, errorMessage) => {
        if (this.concurrentStatus) {
          this.matches[0] = { ...this.matches[0], status: this.concurrentStatus };
          return false;
        }
        const current = this.matches[0];
        if (
          !current ||
          current.id !== expected.id ||
          current.agentId !== expected.agentId ||
          current.facilityId !== expected.facilityId ||
          current.status !== expected.status ||
          current.completedAt !== null
        ) {
          return false;
        }
        this.matches[0] = {
          ...current,
          status: "ABORTED",
          completedAt: closedAt,
          errorMessage,
        };
        return true;
      },
      writeAudit: async (entry) => {
        this.audits.push(entry);
      },
    });
  }
}

function snapshotUnrelated(store: MemoryStore) {
  return structuredClone({
    agent: store.agent,
    centralWatermark: store.centralWatermark,
    drugUsage: store.drugUsage,
    newerBatches: store.newerBatches,
  });
}

describe("bounded stale sync batch abandonment", () => {
  it("allows an active SUPER_ADMIN to abandon only the approved stale batch and audits once", async () => {
    const store = new MemoryStore();
    const unrelatedBefore = snapshotUnrelated(store);

    const result = await createStaleSyncBatchAbandonmentService(store).abandon({
      actorUserId: "super-1",
      batchRef: APPROVED_STALE_BATCH_REF,
      reason: "Legacy completion evidence is unavailable",
      now,
      ip: "127.0.0.1",
    });

    expect(result).toMatchObject({
      batchRef: APPROVED_STALE_BATCH_REF,
      agentId: "agent-05957",
      facilityId: "facility-05957",
      previousStatus: "UPLOADING",
      newStatus: "ABORTED",
    });
    expect(store.matches[0]).toMatchObject({
      status: "ABORTED",
      completedAt: now,
      errorMessage: STALE_BATCH_ABANDONED_MESSAGE,
      recordsRead: 379,
      recordsSent: 379,
      recordsAccepted: 379,
      recordsRejected: 0,
    });
    expect(store.audits).toEqual([
      expect.objectContaining({
        action: "SYNC_BATCH_ABANDONED",
        metadata: expect.objectContaining({
          batchRef: APPROVED_STALE_BATCH_REF,
          agentId: "agent-05957",
          facilityId: "facility-05957",
          previousStatus: "UPLOADING",
          newStatus: "ABORTED",
          recordsRead: 379,
          recordsSent: 379,
          recordsAccepted: 379,
          recordsRejected: 0,
          reason: "Legacy completion evidence is unavailable",
        }),
      }),
    ]);
    expect(snapshotUnrelated(store)).toEqual(unrelatedBefore);
  });

  it("denies inactive and non-SUPER_ADMIN users without changing the batch", async () => {
    for (const actor of [
      { id: "facility-admin", email: "facility@example.test", role: "FACILITY_ADMIN", isActive: true },
      { id: "inactive-super", email: "inactive@example.test", role: "SUPER_ADMIN", isActive: false },
    ]) {
      const store = new MemoryStore();
      store.actor = actor;
      await expect(
        createStaleSyncBatchAbandonmentService(store).abandon({
          actorUserId: actor.id,
          batchRef: APPROVED_STALE_BATCH_REF,
          reason: "Reviewed by owner",
          now,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        createStaleSyncBatchAbandonmentService(store).abandon({
          actorUserId: actor.id,
          batchRef: "SYNC-20261007-999999",
          reason: "Reviewed by owner",
          now,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(store.matches[0].status).toBe("UPLOADING");
      expect(store.audits).toHaveLength(0);
    }
  });

  it("derives Agent and facility from the locked batch and rejects a wrong batch reference", async () => {
    const store = new MemoryStore();
    await expect(
      createStaleSyncBatchAbandonmentService(store).abandon({
        actorUserId: "super-1",
        batchRef: "SYNC-20261007-999999",
        reason: "Reviewed by owner",
        now,
      }),
    ).rejects.toMatchObject({ code: "WRONG_BATCH" });
    expect(store.matches[0].status).toBe("UPLOADING");
    expect(store.audits).toHaveLength(0);
  });

  it("rejects an already terminal batch without rewriting or duplicating audit", async () => {
    const store = new MemoryStore();
    store.matches[0] = { ...store.matches[0], status: "ABORTED", completedAt: now };

    await expect(
      createStaleSyncBatchAbandonmentService(store).abandon({
        actorUserId: "super-1",
        batchRef: APPROVED_STALE_BATCH_REF,
        reason: "Repeat request",
        now,
      }),
    ).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    expect(store.matches[0]).toMatchObject({ status: "ABORTED", completedAt: now });
    expect(store.audits).toHaveLength(0);
  });

  it("fails closed if a concurrent completion wins before the conditional update", async () => {
    const store = new MemoryStore();
    store.concurrentStatus = "COMPLETED";

    await expect(
      createStaleSyncBatchAbandonmentService(store).abandon({
        actorUserId: "super-1",
        batchRef: APPROVED_STALE_BATCH_REF,
        reason: "Reviewed by owner",
        now,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.matches[0].status).toBe("COMPLETED");
    expect(store.audits).toHaveLength(0);
  });

  it("rejects non-stale, ambiguous, or unsuperseded batch evidence", async () => {
    for (const mutate of [
      (store: MemoryStore) => { store.matches[0] = { ...store.matches[0], updatedAt: now }; },
      (store: MemoryStore) => { store.matches.push({ ...store.matches[0], id: "duplicate" }); },
      (store: MemoryStore) => { store.matches[0] = { ...store.matches[0], hasNewerCompletedBatch: false }; },
    ]) {
      const store = new MemoryStore();
      mutate(store);
      await expect(
        createStaleSyncBatchAbandonmentService(store).abandon({
          actorUserId: "super-1",
          batchRef: APPROVED_STALE_BATCH_REF,
          reason: "Reviewed by owner",
          now,
        }),
      ).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
      expect(store.audits).toHaveLength(0);
    }
  });
});
