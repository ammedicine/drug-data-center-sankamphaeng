import { describe, expect, it } from "vitest";

import {
  deriveBackfillPlanForActivation,
  type GlobalSyncStartDateBackfillPlan,
} from "@/lib/services/global-sync-policy";

const now = new Date("2026-10-20T10:00:00.000Z");

describe("active-to-active backfill gap authority", () => {
  it("creates the exact backward gap only on active-to-active activation", () => {
    expect(
      deriveBackfillPlanForActivation({
        previousActiveDate: "2025-01-01",
        newActiveDate: "2024-10-01",
        policyRevision: 7,
        actorUserId: "super-1",
        now,
        currentPlan: null,
      }),
    ).toEqual({
      policyRevision: 7,
      from: "2024-10-01",
      to: "2024-12-31",
      status: "ACTIVE",
      createdAt: now.toISOString(),
      createdByUserId: "super-1",
    });
  });

  it("creates no gap for legacy first activation or a forward/equal move", () => {
    for (const [previousActiveDate, newActiveDate] of [
      [null, "2024-10-01"],
      ["2024-10-01", "2025-01-01"],
      ["2024-10-01", "2024-10-01"],
    ] as const) {
      expect(
        deriveBackfillPlanForActivation({
          previousActiveDate,
          newActiveDate,
          policyRevision: 7,
          actorUserId: "super-1",
          now,
          currentPlan: null,
        }),
      ).toBeNull();
    }
  });

  it("blocks an incompatible activation while the current plan is unresolved", () => {
    const currentPlan: GlobalSyncStartDateBackfillPlan = {
      policyRevision: 6,
      from: "2024-10-01",
      to: "2024-12-31",
      status: "ACTIVE",
      createdAt: "2026-10-19T10:00:00.000Z",
      createdByUserId: "super-1",
    };

    expect(() =>
      deriveBackfillPlanForActivation({
        previousActiveDate: "2024-10-01",
        newActiveDate: "2024-07-01",
        policyRevision: 7,
        actorUserId: "super-1",
        now,
        currentPlan,
      }),
    ).toThrow(/unresolved backfill plan/i);
  });

  it("allows a new gap after the previous plan is explicitly terminal", () => {
    const currentPlan: GlobalSyncStartDateBackfillPlan = {
      policyRevision: 6,
      from: "2024-10-01",
      to: "2024-12-31",
      status: "COMPLETED",
      createdAt: "2026-10-19T10:00:00.000Z",
      createdByUserId: "super-1",
      resolvedAt: "2026-10-20T09:00:00.000Z",
      resolvedByUserId: "super-1",
      resolutionReason: "ครบทุก Agent ตามแผน",
    };

    expect(
      deriveBackfillPlanForActivation({
        previousActiveDate: "2024-10-01",
        newActiveDate: "2024-07-01",
        policyRevision: 7,
        actorUserId: "super-1",
        now,
        currentPlan,
      }),
    ).toMatchObject({ from: "2024-07-01", to: "2024-09-30", status: "ACTIVE" });
  });
});
