import { describe, expect, it } from "vitest";

import {
  SyncCompletionConflictError,
  assessSyncCompletion,
  type SyncCompletionBatch,
} from "@/lib/services/sync-completion";

const batch: SyncCompletionBatch = {
  id: "batch-1",
  agentId: "agent-1",
  facilityId: "facility-1",
  batchRef: "SYNC-20261021-000001",
  status: "COMPLETED",
  rangeTo: "2026-10-21",
  completedAt: new Date("2026-10-21T08:00:00.000Z"),
  recordsRead: 5574,
  recordsSent: 5574,
  recordsRejected: 0,
  errorMessage: null,
};

const payload = {
  authenticatedAgentId: "agent-1",
  authenticatedFacilityId: "facility-1",
  batchRef: "SYNC-20261021-000001",
  status: "COMPLETED" as const,
  recordsRead: 5574,
  recordsSent: 5574,
  lastVisitDate: "2026-10-21",
  errorMessage: null,
};

describe("idempotent normal sync completion", () => {
  it("replays an identical completed request without applying side effects again", () => {
    expect(assessSyncCompletion(batch, payload)).toEqual({ replay: true });
  });

  it("rejects a duplicate from another authenticated Agent or facility", () => {
    expect(() =>
      assessSyncCompletion(batch, { ...payload, authenticatedAgentId: "agent-2" }),
    ).toThrow(SyncCompletionConflictError);
    expect(() =>
      assessSyncCompletion(batch, { ...payload, authenticatedFacilityId: "facility-2" }),
    ).toThrow(SyncCompletionConflictError);
  });

  it("rejects a completed batch when the repeated completion payload differs", () => {
    for (const changed of [
      { ...payload, recordsRead: 5573 },
      { ...payload, recordsSent: 5573 },
      { ...payload, lastVisitDate: "2026-10-20" },
      { ...payload, status: "FAILED" as const },
    ]) {
      expect(() => assessSyncCompletion(batch, changed)).toThrow(SyncCompletionConflictError);
    }
  });

  it("allows the first completion only while the batch is still open", () => {
    expect(assessSyncCompletion({ ...batch, status: "UPLOADING" }, payload)).toEqual({
      replay: false,
    });
    expect(() =>
      assessSyncCompletion({ ...batch, status: "FAILED" }, payload),
    ).toThrow(SyncCompletionConflictError);
  });
});
