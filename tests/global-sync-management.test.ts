import { describe, expect, it } from "vitest";

import {
  GlobalSyncStartDateManagementError,
  createGlobalSyncStartDateManagementService,
  globalSyncStartDateReadiness,
  type GlobalSyncStartDateManagementStore,
  type LockedGlobalSyncStartDateManagement,
  type ManagedGlobalSyncStartDateAgent,
} from "@/lib/services/global-sync-policy-management";
import type { GlobalSyncStartDatePolicy } from "@/lib/services/global-sync-policy";

const now = new Date("2026-10-20T10:00:00.000Z");
const initial: GlobalSyncStartDatePolicy = {
  schemaVersion: 1,
  desiredDate: "2025-10-01",
  desiredRevision: 2,
  activeDate: null,
  activeRevision: 0,
  updatedBy: "super-1",
  updatedAt: "2026-10-19T10:00:00.000Z",
};

function agent(
  id: string,
  input: Partial<ManagedGlobalSyncStartDateAgent> = {},
): ManagedGlobalSyncStartDateAgent {
  return {
    agentId: id,
    supportsRemoteSyncStartDate: true,
    appliedRevision: 2,
    syncControlState: "PAUSED",
    ...input,
  };
}

class MemoryManagementStore implements GlobalSyncStartDateManagementStore {
  policy: GlobalSyncStartDatePolicy | null;
  agents: ManagedGlobalSyncStartDateAgent[];
  activeBatch = false;
  actor = { id: "super-1", email: "super@example.test", role: "SUPER_ADMIN", isActive: true };
  audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];

  constructor(
    policy: GlobalSyncStartDatePolicy | null = initial,
    agents: ManagedGlobalSyncStartDateAgent[] = [agent("agent-1")],
  ) {
    this.policy = policy;
    this.agents = agents;
  }

  async withLock<T>(
    _actorUserId: string,
    work: (locked: LockedGlobalSyncStartDateManagement) => Promise<T>,
  ): Promise<T> {
    return work({
      actor: this.actor,
      policy: this.policy,
      agents: this.agents,
      hasActiveBatch: this.activeBatch,
      savePolicy: async (policy) => {
        this.policy = policy;
      },
      writeAudit: async (entry) => {
        this.audits.push(entry);
      },
    });
  }
}

describe("Global Sync Start Date fleet readiness", () => {
  it("reports APPLIED, PENDING, and UNSUPPORTED from capability and acknowledgement", () => {
    expect(
      globalSyncStartDateReadiness(initial, [
        agent("applied"),
        agent("pending", { appliedRevision: 1 }),
        agent("unsupported", { supportsRemoteSyncStartDate: false, appliedRevision: null }),
      ]),
    ).toEqual([
      { agentId: "applied", status: "APPLIED" },
      { agentId: "pending", status: "PENDING" },
      { agentId: "unsupported", status: "UNSUPPORTED" },
    ]);
  });
});

describe("SUPER_ADMIN policy management", () => {
  it("refuses inactive and non-SUPER_ADMIN actors before writing", async () => {
    for (const actor of [
      { id: "facility-1", email: "facility@example.test", role: "FACILITY_ADMIN", isActive: true },
      { id: "super-off", email: "off@example.test", role: "SUPER_ADMIN", isActive: false },
    ]) {
      const store = new MemoryManagementStore();
      store.actor = actor;
      const service = createGlobalSyncStartDateManagementService(store);

      await expect(
        service.saveDesired({
          actorUserId: actor.id,
          desiredDate: "2026-10-01",
          expectedDesiredRevision: 2,
          now,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(store.policy).toEqual(initial);
      expect(store.audits).toHaveLength(0);
    }
  });

  it("saves a rollback date as a new higher desired revision without activating it", async () => {
    const active: GlobalSyncStartDatePolicy = {
      ...initial,
      activeDate: "2024-10-01",
      activeRevision: 1,
    };
    const store = new MemoryManagementStore(active);
    const service = createGlobalSyncStartDateManagementService(store);

    const result = await service.saveDesired({
      actorUserId: "super-1",
      desiredDate: "2023-10-01",
      expectedDesiredRevision: 2,
      now,
    });

    expect(result.desiredRevision).toBe(3);
    expect(result.activeDate).toBe("2024-10-01");
    expect(result.activeRevision).toBe(1);
    expect(store.audits).toMatchObject([
      { action: "GLOBAL_SYNC_START_DATE_DESIRED_SET" },
    ]);
  });

  it("blocks activation while any Central batch is active", async () => {
    const store = new MemoryManagementStore();
    store.activeBatch = true;
    const service = createGlobalSyncStartDateManagementService(store);

    await expect(
      service.activateDesired({
        actorUserId: "super-1",
        expectedDesiredRevision: 2,
        overridePending: false,
        overrideReason: null,
        now,
      }),
    ).rejects.toMatchObject({ code: "ACTIVE_BATCH" });
    expect(store.policy?.activeRevision).toBe(0);
  });

  it("requires every Agent to be applied when no override is requested", async () => {
    const store = new MemoryManagementStore(initial, [
      agent("ready"),
      agent("pending", { appliedRevision: 1 }),
    ]);
    const service = createGlobalSyncStartDateManagementService(store);

    await expect(
      service.activateDesired({
        actorUserId: "super-1",
        expectedDesiredRevision: 2,
        overridePending: false,
        overrideReason: null,
        now,
      }),
    ).rejects.toMatchObject({ code: "FLEET_NOT_READY" });
  });

  it("requires explicit confirmation, a reason, and PAUSED pending/unsupported Agents", async () => {
    const store = new MemoryManagementStore(initial, [
      agent("pending", { appliedRevision: 1, syncControlState: "RUNNING" }),
      agent("old", {
        supportsRemoteSyncStartDate: false,
        appliedRevision: null,
        syncControlState: "PAUSED",
      }),
    ]);
    const service = createGlobalSyncStartDateManagementService(store);

    for (const input of [
      { overridePending: false, overrideReason: "ยืนยัน" },
      { overridePending: true, overrideReason: "" },
      { overridePending: true, overrideReason: "ยืนยันโดยเจ้าของ" },
    ]) {
      await expect(
        service.activateDesired({
          actorUserId: "super-1",
          expectedDesiredRevision: 2,
          now,
          ...input,
        }),
      ).rejects.toBeInstanceOf(GlobalSyncStartDateManagementError);
    }
    expect(store.policy?.activeRevision).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("activates with an audited override and leaves unsupported Agents paused", async () => {
    const store = new MemoryManagementStore(initial, [
      agent("ready"),
      agent("pending", { appliedRevision: 1 }),
      agent("old", { supportsRemoteSyncStartDate: false, appliedRevision: null }),
    ]);
    const beforeStates = store.agents.map((row) => row.syncControlState);
    const service = createGlobalSyncStartDateManagementService(store);

    const result = await service.activateDesired({
      actorUserId: "super-1",
      expectedDesiredRevision: 2,
      overridePending: true,
      overrideReason: "เครื่องเก่าออฟไลน์และหยุดไว้แล้ว",
      now,
    });

    expect(result).toMatchObject({
      activeDate: "2025-10-01",
      activeRevision: 2,
    });
    expect(store.agents.map((row) => row.syncControlState)).toEqual(beforeStates);
    expect(store.audits).toMatchObject([
      {
        action: "GLOBAL_SYNC_START_DATE_ACTIVATED_OVERRIDE",
        metadata: {
          activeRevision: 2,
          reason: "เครื่องเก่าออฟไลน์และหยุดไว้แล้ว",
          overriddenAgentIds: ["pending", "old"],
        },
      },
    ]);
  });
});
