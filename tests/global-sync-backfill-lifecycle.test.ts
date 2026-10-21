import { describe, expect, it } from "vitest";

import {
  GlobalSyncBackfillError,
  assertBackfillRequestEligible,
  assertBackfillTransition,
  buildBackfillRequest,
  type BackfillEligibilityInput,
} from "@/lib/services/global-sync-backfill";
import type { GlobalSyncStartDatePolicy } from "@/lib/services/global-sync-policy";

const now = new Date("2026-10-20T10:00:00.000Z");
const policy: GlobalSyncStartDatePolicy = {
  schemaVersion: 1,
  desiredDate: "2024-10-01",
  desiredRevision: 3,
  activeDate: "2024-10-01",
  activeRevision: 3,
  updatedBy: "super-1",
  updatedAt: now.toISOString(),
  backfillPlan: {
    policyRevision: 3,
    from: "2024-10-01",
    to: "2024-12-31",
    status: "ACTIVE",
    createdAt: now.toISOString(),
    createdByUserId: "super-1",
  },
};

function eligible(
  overrides: Partial<BackfillEligibilityInput> = {},
): BackfillEligibilityInput {
  return {
    actor: { id: "super-1", role: "SUPER_ADMIN", isActive: true },
    agent: {
      id: "agent-1",
      facilityId: "facility-server-derived",
      online: true,
      capabilities: { remoteSyncStartDate: true, idempotentUploadChunk: true },
      appliedPolicyRevision: 3,
      desiredSyncState: "PAUSED",
      effectiveSyncState: "PAUSED",
      queuePendingCount: 0,
      queueFailedCount: 0,
      queueTelemetryAt: now,
    },
    policy,
    rangeFrom: "2024-10-01",
    rangeTo: "2024-12-31",
    reason: "กู้ข้อมูลย้อนหลังตามแผน",
    hasOpenRequest: false,
    hasActiveBatch: false,
    hasManualRequest: false,
    now,
    ...overrides,
  };
}

describe("historical backfill request eligibility", () => {
  it("builds an immutable request using the server-side Agent facility", () => {
    const input = eligible();
    expect(assertBackfillRequestEligible(input)).toBeUndefined();
    expect(buildBackfillRequest(input, "request-new")).toMatchObject({
      id: "request-new",
      agentId: "agent-1",
      facilityId: "facility-server-derived",
      policyRevision: 3,
      rangeFrom: "2024-10-01",
      rangeTo: "2024-12-31",
      status: "REQUESTED",
    });
  });

  it.each([
    [
      "FORBIDDEN",
      {
        actor: { id: "facility-admin", role: "FACILITY_ADMIN", isActive: true },
      },
    ],
    [
      "CAPABILITY_REQUIRED",
      {
        agent: {
          ...eligible().agent,
          capabilities: {
            remoteSyncStartDate: false,
            idempotentUploadChunk: true,
          },
        },
      },
    ],
    [
      "CAPABILITY_REQUIRED",
      {
        agent: {
          ...eligible().agent,
          capabilities: {
            remoteSyncStartDate: true,
            idempotentUploadChunk: false,
          },
        },
      },
    ],
    [
      "POLICY_REVISION_MISMATCH",
      { agent: { ...eligible().agent, appliedPolicyRevision: 2 } },
    ],
    [
      "PAUSE_REQUIRED",
      { agent: { ...eligible().agent, desiredSyncState: "RUNNING" } },
    ],
    [
      "EFFECTIVE_PAUSE_REQUIRED",
      { agent: { ...eligible().agent, effectiveSyncState: "PAUSE_REQUESTED" } },
    ],
    [
      "TELEMETRY_UNKNOWN",
      { agent: { ...eligible().agent, queuePendingCount: null } },
    ],
    [
      "QUEUE_NOT_EMPTY",
      { agent: { ...eligible().agent, queuePendingCount: 1 } },
    ],
    [
      "FAILED_QUEUE_NOT_EMPTY",
      { agent: { ...eligible().agent, queueFailedCount: 1 } },
    ],
    ["OPEN_REQUEST", { hasOpenRequest: true }],
    ["ACTIVE_BATCH", { hasActiveBatch: true }],
    ["MANUAL_REQUEST", { hasManualRequest: true }],
    ["RANGE_NOT_AUTHORIZED", { rangeFrom: "2024-09-30" }],
  ])("rejects %s", (code, overrides) => {
    expect(() =>
      assertBackfillRequestEligible(
        eligible(overrides as Partial<BackfillEligibilityInput>),
      ),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("allows an offline Agent to remain REQUESTED without trusting effective state", () => {
    const input = eligible({
      agent: { ...eligible().agent, online: false, effectiveSyncState: null },
    });
    expect(assertBackfillRequestEligible(input)).toBeUndefined();
  });

  it("rejects stale queue telemetry as UNKNOWN", () => {
    const input = eligible({
      agent: {
        ...eligible().agent,
        queueTelemetryAt: new Date("2026-10-20T09:54:59.000Z"),
      },
    });
    expect(() => assertBackfillRequestEligible(input)).toThrowError(
      expect.objectContaining({ code: "TELEMETRY_UNKNOWN" }),
    );
  });
});

describe("historical backfill lifecycle", () => {
  it("permits only forward open-to-terminal transitions", () => {
    for (const [from, to] of [
      ["REQUESTED", "IN_PROGRESS"],
      ["REQUESTED", "FAILED"],
      ["REQUESTED", "CANCELLED"],
      ["IN_PROGRESS", "COMPLETED"],
      ["IN_PROGRESS", "FAILED"],
      ["IN_PROGRESS", "CANCELLED"],
    ] as const) {
      expect(() => assertBackfillTransition(from, to)).not.toThrow();
    }
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"] as const)(
    "never reopens terminal state %s",
    (terminal) => {
      for (const next of ["REQUESTED", "IN_PROGRESS"] as const) {
        expect(() => assertBackfillTransition(terminal, next)).toThrow(
          GlobalSyncBackfillError,
        );
      }
    },
  );
});
