import { describe, expect, it } from "vitest";

import { heartbeatSchema } from "@/lib/agent-auth/heartbeat-schema";
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
