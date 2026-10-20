import { describe, expect, it } from "vitest";

import {
  GlobalSyncStartDatePolicyConflictError,
  GlobalSyncStartDatePolicyValidationError,
  createGlobalSyncStartDatePolicyService,
  type GlobalSyncStartDatePolicy,
  type GlobalSyncStartDatePolicyStore,
  type LockedGlobalSyncStartDatePolicy,
} from "@/lib/services/global-sync-policy";

class MemoryPolicyStore implements GlobalSyncStartDatePolicyStore {
  value: unknown | null;
  writes = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(value: unknown | null = null) {
    this.value = value;
  }

  async read(): Promise<unknown | null> {
    return this.value;
  }

  async withLock<T>(work: (locked: LockedGlobalSyncStartDatePolicy) => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work({
        value: this.value,
        save: async (value) => {
          this.value = value;
          this.writes += 1;
        },
      });
    } finally {
      release();
    }
  }
}

const actor = "user-super-admin";
const at = new Date("2026-10-20T10:00:00.000Z");

describe("global sync start date policy state", () => {
  it("treats a missing row as valid legacy state", async () => {
    const service = createGlobalSyncStartDatePolicyService(new MemoryPolicyStore());

    await expect(service.get()).resolves.toBeNull();
  });

  it("creates the first desired date at revision one without activating it", async () => {
    const store = new MemoryPolicyStore();
    const service = createGlobalSyncStartDatePolicyService(store);

    const result = await service.setDesiredDate({
      desiredDate: "2025-10-01",
      expectedDesiredRevision: 0,
      updatedBy: actor,
      now: at,
    });

    expect(result.changed).toBe(true);
    expect(result.policy).toEqual({
      schemaVersion: 1,
      desiredDate: "2025-10-01",
      desiredRevision: 1,
      activeDate: null,
      activeRevision: 0,
      updatedBy: actor,
      updatedAt: "2026-10-20T10:00:00.000Z",
    });
    expect(store.writes).toBe(1);
  });

  it("does not create a revision or write when the desired date is unchanged", async () => {
    const initial: GlobalSyncStartDatePolicy = {
      schemaVersion: 1,
      desiredDate: "2025-10-01",
      desiredRevision: 4,
      activeDate: "2024-10-01",
      activeRevision: 3,
      updatedBy: actor,
      updatedAt: "2026-10-19T10:00:00.000Z",
    };
    const store = new MemoryPolicyStore(initial);
    const service = createGlobalSyncStartDatePolicyService(store);

    const result = await service.setDesiredDate({
      desiredDate: "2025-10-01",
      expectedDesiredRevision: 1,
      updatedBy: "stale-retry",
      now: at,
    });

    expect(result).toEqual({ changed: false, policy: initial });
    expect(store.writes).toBe(0);
  });

  it("increments desired revision while leaving active state independent", async () => {
    const store = new MemoryPolicyStore({
      schemaVersion: 1,
      desiredDate: "2025-10-01",
      desiredRevision: 4,
      activeDate: "2024-10-01",
      activeRevision: 3,
      updatedBy: actor,
      updatedAt: "2026-10-19T10:00:00.000Z",
    });
    const service = createGlobalSyncStartDatePolicyService(store);

    const result = await service.setDesiredDate({
      desiredDate: "2026-10-01",
      expectedDesiredRevision: 4,
      updatedBy: actor,
      now: at,
    });

    expect(result.policy.desiredRevision).toBe(5);
    expect(result.policy.activeDate).toBe("2024-10-01");
    expect(result.policy.activeRevision).toBe(3);
  });

  it("rejects one of two stale concurrent changes instead of silently losing a revision", async () => {
    const store = new MemoryPolicyStore({
      schemaVersion: 1,
      desiredDate: "2025-10-01",
      desiredRevision: 1,
      activeDate: null,
      activeRevision: 0,
      updatedBy: actor,
      updatedAt: "2026-10-19T10:00:00.000Z",
    });
    const service = createGlobalSyncStartDatePolicyService(store);

    const outcomes = await Promise.allSettled([
      service.setDesiredDate({
        desiredDate: "2026-01-01",
        expectedDesiredRevision: 1,
        updatedBy: "admin-a",
        now: at,
      }),
      service.setDesiredDate({
        desiredDate: "2026-02-01",
        expectedDesiredRevision: 1,
        updatedBy: "admin-b",
        now: at,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(GlobalSyncStartDatePolicyConflictError),
    });
    expect((store.value as GlobalSyncStartDatePolicy).desiredRevision).toBe(2);
    expect(store.writes).toBe(1);
  });

  it("fails safely when persisted JSON is invalid", async () => {
    const store = new MemoryPolicyStore({
      schemaVersion: 1,
      desiredDate: "2026-02-30",
      desiredRevision: 1,
      activeDate: null,
      activeRevision: 0,
      updatedBy: actor,
      updatedAt: "not-a-timestamp",
    });
    const service = createGlobalSyncStartDatePolicyService(store);

    await expect(service.get()).rejects.toBeInstanceOf(
      GlobalSyncStartDatePolicyValidationError,
    );
    expect(store.writes).toBe(0);
  });
});
