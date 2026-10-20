import { describe, expect, it } from "vitest";

import { CentralApiError } from "../agent/src/central/client";
import {
  GLOBAL_SYNC_START_DATE_ENFORCED_CODE,
  GLOBAL_SYNC_START_DATE_RETRY_AFTER_SECONDS,
  GlobalSyncStartDateEnforcedError,
  assertGlobalSyncStartDateRecordsAllowed,
  assertGlobalSyncStartDateRangeAllowed,
} from "@/lib/services/global-sync-enforcement";
import type { GlobalSyncStartDatePolicy } from "@/lib/services/global-sync-policy";

function policy(activeDate: string | null, activeRevision: number): GlobalSyncStartDatePolicy {
  return {
    schemaVersion: 1,
    desiredDate: "2025-10-01",
    desiredRevision: 3,
    activeDate,
    activeRevision,
    updatedBy: "super-1",
    updatedAt: "2026-10-20T10:00:00.000Z",
  };
}

describe("Central active-floor enforcement", () => {
  it("does not enforce a desired-only policy", () => {
    expect(() =>
      assertGlobalSyncStartDateRangeAllowed(policy(null, 0), {
        rangeFrom: "2020-01-01",
        rangeTo: "2020-01-31",
      }),
    ).not.toThrow();
  });

  it("accepts ranges and records exactly on or after the active floor", () => {
    const active = policy("2025-10-01", 3);
    expect(() =>
      assertGlobalSyncStartDateRangeAllowed(active, {
        rangeFrom: "2025-10-01",
        rangeTo: "2025-10-31",
      }),
    ).not.toThrow();
    expect(() =>
      assertGlobalSyncStartDateRecordsAllowed(active, [
        { usageDate: "2025-10-01" },
        { usageDate: "2026-01-01" },
      ]),
    ).not.toThrow();
  });

  it("rejects a below-floor batch before caller mutation", () => {
    const state = { batches: 0, watermark: "2025-09-30", historyRows: 42 };

    expect(() => {
      assertGlobalSyncStartDateRangeAllowed(policy("2025-10-01", 3), {
        rangeFrom: "2025-09-30",
        rangeTo: "2025-10-31",
      });
      state.batches += 1;
      state.watermark = "2025-10-31";
    }).toThrow(GlobalSyncStartDateEnforcedError);

    expect(state).toEqual({ batches: 0, watermark: "2025-09-30", historyRows: 42 });
  });

  it("rejects an entire mixed-date chunk without partial processing", () => {
    const state = { upserts: 0, rejects: 0, batchCounter: 7 };
    expect(() => {
      assertGlobalSyncStartDateRecordsAllowed(policy("2025-10-01", 3), [
        { usageDate: "2025-10-01" },
        { usageDate: "2025-09-30" },
        { usageDate: "2026-01-01" },
      ]);
      state.upserts += 3;
      state.batchCounter += 3;
    }).toThrow(GlobalSyncStartDateEnforcedError);
    expect(state).toEqual({ upserts: 0, rejects: 0, batchCounter: 7 });
  });

  it("leaves malformed dates to the existing row-validation path", () => {
    expect(() =>
      assertGlobalSyncStartDateRecordsAllowed(policy("2025-10-01", 3), [
        { usageDate: "" },
        { usageDate: "not-a-date" },
      ]),
    ).not.toThrow();
  });

  it("uses exact 503 retry semantics that old Agents keep pending", () => {
    const error = new GlobalSyncStartDateEnforcedError("2025-10-01");
    expect(error.status).toBe(503);
    expect(error.code).toBe(GLOBAL_SYNC_START_DATE_ENFORCED_CODE);
    expect(error.retryAfterSeconds).toBe(GLOBAL_SYNC_START_DATE_RETRY_AFTER_SECONDS);
    expect(error.retryAfterSeconds).toBe(45);

    const oldAgentView = new CentralApiError(
      error.status,
      error.code,
      error.message,
      error.retryAfterSeconds,
    );
    expect(oldAgentView.permanent).toBe(false);
  });
});
