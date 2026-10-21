import { describe, expect, it } from "vitest";

import {
  heartbeatSchema,
  phaseEQueueTelemetryUpdate,
} from "@/lib/agent-auth/heartbeat-schema";
import { isMatchingHistoricalBackfillCoverage } from "@/lib/services/global-sync-backfill";
import {
  buildGlobalSyncStartDateHeartbeatConfig,
  createGlobalSyncStartDateAcknowledgementService,
  type GlobalSyncStartDateAcknowledgementStore,
  type GlobalSyncStartDatePolicy,
  type LockedAgentGlobalSyncStartDateAcknowledgement,
} from "@/lib/services/global-sync-policy";

const policy: GlobalSyncStartDatePolicy = {
  schemaVersion: 1,
  desiredDate: "2025-10-01",
  desiredRevision: 3,
  activeDate: "2024-10-01",
  activeRevision: 2,
  updatedBy: "user-super-admin",
  updatedAt: "2026-10-20T10:00:00.000Z",
};

const oldHeartbeat = {
  agentVersion: "1.1.16",
  hostname: "RPST-01",
  installationId: "install-01",
  status: "ONLINE" as const,
  jhcisConnected: true,
  pcucode: "05957",
};

class MemoryAcknowledgementStore implements GlobalSyncStartDateAcknowledgementStore {
  private revisions = new Map<string, { revision: number; appliedAt: Date }>();

  async withAgentLock<T>(
    agentId: string,
    work: (locked: LockedAgentGlobalSyncStartDateAcknowledgement) => Promise<T>,
  ): Promise<T> {
    const current = this.revisions.get(agentId) ?? null;
    return work({
      revision: current?.revision ?? null,
      save: async (revision, appliedAt) => {
        this.revisions.set(agentId, { revision, appliedAt });
      },
    });
  }

  get(agentId: string) {
    return this.revisions.get(agentId) ?? null;
  }
}

describe("additive heartbeat contract", () => {
  it("continues to accept the old heartbeat payload", () => {
    expect(heartbeatSchema.safeParse(oldHeartbeat).success).toBe(true);
    expect(
      heartbeatSchema.safeParse({ ...oldHeartbeat, futureOptionalField: "ignored" }).success,
    ).toBe(true);
  });

  it("leaves Phase E telemetry untouched when an older heartbeat omits it", () => {
    const reportedAt = new Date("2026-10-21T00:00:00.000Z");
    expect(phaseEQueueTelemetryUpdate(undefined, reportedAt)).toEqual({});
  });

  it("preserves explicit zero telemetry as known zero", () => {
    const reportedAt = new Date("2026-10-21T00:00:00.000Z");
    expect(phaseEQueueTelemetryUpdate({
      pending: 0,
      failed: 0,
      quarantineTotal: 0,
      quarantineCovered: 0,
      quarantineUnresolved: 0,
    }, reportedAt)).toEqual({
      queuePendingCount: 0,
      queueFailedCount: 0,
      quarantineTotalCount: 0,
      quarantineCoveredCount: 0,
      quarantineUnresolvedCount: 0,
      queueTelemetryAt: reportedAt,
    });
  });

  it("accepts bounded request-specific coverage evidence", () => {
    expect(heartbeatSchema.safeParse({
      ...oldHeartbeat,
      historicalBackfillReport: {
        requestId: "backfill-request-1",
        policyRevision: 7,
        from: "2024-10-01",
        to: "2024-12-31",
        batchRef: "SYNC-HISTORY-1",
        covered: 2,
        unresolved: 0,
      },
    }).success).toBe(true);
  });

  it("omits managed-policy fields when no policy exists", () => {
    expect(buildGlobalSyncStartDateHeartbeatConfig(null)).toEqual({});
  });

  it("adds only the Agent-facing desired and active policy fields", () => {
    expect(buildGlobalSyncStartDateHeartbeatConfig(policy)).toEqual({
      globalSyncStartDatePolicy: {
        schemaVersion: 1,
        desiredDate: "2025-10-01",
        desiredRevision: 3,
        activeDate: "2024-10-01",
        activeRevision: 2,
      },
    });
  });

  it("rejects impossible dates and invalid applied revisions before state can change", () => {
    expect(
      heartbeatSchema.safeParse({ ...oldHeartbeat, syncStartDate: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      heartbeatSchema.safeParse({
        ...oldHeartbeat,
        appliedGlobalSyncStartDateRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      heartbeatSchema.safeParse({
        ...oldHeartbeat,
        appliedGlobalSyncStartDateRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });
});

describe("historical coverage acknowledgement", () => {
  const row = {
    agentId: "agent-current",
    status: "COMPLETED" as const,
    policyRevision: 7,
    rangeFrom: "2024-10-01",
    rangeTo: "2024-12-31",
    linkedBatchId: "batch-current",
    linkedBatchRef: "SYNC-HISTORY-1",
  };
  const evidence = {
    requestId: "request-current",
    authenticatedAgentId: "agent-current",
    policyRevision: 7,
    from: "2024-10-01",
    to: "2024-12-31",
    batchRef: "SYNC-HISTORY-1",
  };

  it("requires a completed request bound to the authenticated Agent and exact revision/range", () => {
    expect(isMatchingHistoricalBackfillCoverage(row, evidence)).toBe(true);
    expect(isMatchingHistoricalBackfillCoverage({ ...row, agentId: "agent-older" }, evidence)).toBe(false);
    expect(isMatchingHistoricalBackfillCoverage({ ...row, status: "IN_PROGRESS" }, evidence)).toBe(false);
    expect(isMatchingHistoricalBackfillCoverage({ ...row, policyRevision: 6 }, evidence)).toBe(false);
    expect(isMatchingHistoricalBackfillCoverage({ ...row, rangeTo: "2025-01-01" }, evidence)).toBe(false);
    expect(isMatchingHistoricalBackfillCoverage({ ...row, linkedBatchRef: "SYNC-OLDER" }, evidence)).toBe(false);
    expect(isMatchingHistoricalBackfillCoverage({ ...row, linkedBatchId: null }, evidence)).toBe(false);
  });
});

describe("authenticated Agent acknowledgement", () => {
  it("stores a valid acknowledgement only under the authenticated Agent id", async () => {
    const store = new MemoryAcknowledgementStore();
    const service = createGlobalSyncStartDateAcknowledgementService(store);
    const appliedAt = new Date("2026-10-20T10:00:00.000Z");

    await expect(
      service.record({
        authenticatedAgentId: "agent-authenticated",
        reportedRevision: 3,
        policy,
        appliedAt,
      }),
    ).resolves.toBe(true);

    expect(store.get("agent-authenticated")).toEqual({ revision: 3, appliedAt });
    expect(store.get("agent-from-caller")).toBeNull();
  });

  it("does not let a stale report overwrite a newer applied revision", async () => {
    const store = new MemoryAcknowledgementStore();
    const service = createGlobalSyncStartDateAcknowledgementService(store);

    await service.record({
      authenticatedAgentId: "agent-a",
      reportedRevision: 3,
      policy,
      appliedAt: new Date("2026-10-20T10:00:00.000Z"),
    });
    await expect(
      service.record({
        authenticatedAgentId: "agent-a",
        reportedRevision: 2,
        policy,
        appliedAt: new Date("2026-10-20T11:00:00.000Z"),
      }),
    ).resolves.toBe(false);

    expect(store.get("agent-a")).toEqual({
      revision: 3,
      appliedAt: new Date("2026-10-20T10:00:00.000Z"),
    });
  });

  it("ignores acknowledgements when policy is absent or revision is ahead of desired", async () => {
    const store = new MemoryAcknowledgementStore();
    const service = createGlobalSyncStartDateAcknowledgementService(store);
    const appliedAt = new Date("2026-10-20T10:00:00.000Z");

    await expect(
      service.record({
        authenticatedAgentId: "agent-a",
        reportedRevision: 1,
        policy: null,
        appliedAt,
      }),
    ).resolves.toBe(false);
    await expect(
      service.record({
        authenticatedAgentId: "agent-a",
        reportedRevision: 4,
        policy,
        appliedAt,
      }),
    ).resolves.toBe(false);
    expect(store.get("agent-a")).toBeNull();
  });
});
