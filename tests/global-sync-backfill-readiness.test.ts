import { describe, expect, it } from "vitest";

import { evaluateGlobalSyncBackfillReadiness } from "@/lib/services/global-sync-backfill-readiness";

const now = new Date("2026-10-21T00:00:00.000Z");
const base = {
  now,
  policy: {
    activeRevision: 7,
    backfillPlan: { policyRevision: 7, from: "2024-10-01", to: "2024-12-31", status: "ACTIVE" as const },
  },
  agent: {
    capabilities: { remoteSyncStartDate: true, idempotentUploadChunk: true },
    appliedPolicyRevision: 7,
    desiredSyncState: "PAUSED" as const,
    effectiveSyncState: "PAUSED" as const,
    online: true,
    queuePendingCount: 0,
    queueFailedCount: 0,
    quarantineTotalCount: 2,
    queueTelemetryAt: new Date("2026-10-20T23:59:00.000Z"),
    hasActiveBatch: false,
    hasManualRequest: false,
    currentError: null,
  },
  request: {
    id: "request-current",
    policyRevision: 7,
    rangeFrom: "2024-10-01",
    rangeTo: "2024-12-31",
    status: "COMPLETED" as const,
    reconciliationGap: 0,
    quarantineCovered: 1,
    quarantineUnresolved: 0,
  },
};

describe("current-request backfill readiness", () => {
  it("is READY only for fresh clean evidence bound to the current plan", () => {
    expect(evaluateGlobalSyncBackfillReadiness(base)).toEqual({ state: "READY", reasons: [] });
  });

  it.each([
    ["missing", { queuePendingCount: null }],
    ["stale", { queueTelemetryAt: new Date("2026-10-20T23:00:00.000Z") }],
  ])("treats %s telemetry as UNKNOWN", (_label, patch) => {
    expect(evaluateGlobalSyncBackfillReadiness({
      ...base, agent: { ...base.agent, ...patch },
    }).state).toBe("UNKNOWN");
  });

  it("does not reuse an older request revision/range", () => {
    const result = evaluateGlobalSyncBackfillReadiness({
      ...base, request: { ...base.request, policyRevision: 6 },
    });
    expect(result.state).toBe("UNKNOWN");
    expect(result.reasons).toContain("REQUEST_EVIDENCE_MISMATCH");
    expect(evaluateGlobalSyncBackfillReadiness({
      ...base, request: { ...base.request, rangeFrom: "2024-09-30" },
    }).state).toBe("UNKNOWN");
  });

  it("accepts a completed exact request range contained by the current plan", () => {
    expect(evaluateGlobalSyncBackfillReadiness({
      ...base,
      request: {
        ...base.request,
        rangeFrom: "2024-11-01",
        rangeTo: "2024-11-30",
      },
    }).state).toBe("READY");
  });

  it.each([
    ["CAPABILITY_REQUIRED", { capabilities: { remoteSyncStartDate: false, idempotentUploadChunk: true } }],
    ["POLICY_REVISION_MISMATCH", { appliedPolicyRevision: 6 }],
    ["PAUSE_REQUIRED", { desiredSyncState: "RUNNING" as const }],
    ["ACTIVE_BATCH", { hasActiveBatch: true }],
    ["MANUAL_REQUEST", { hasManualRequest: true }],
    ["PENDING_QUEUE", { queuePendingCount: 1 }],
    ["FAILED_QUEUE", { queueFailedCount: 1 }],
    ["CURRENT_ERROR", { currentError: "upload conflict" }],
  ])("returns NOT_READY for %s", (reason, patch) => {
    const result = evaluateGlobalSyncBackfillReadiness({
      ...base, agent: { ...base.agent, ...patch },
    });
    expect(result.state).toBe("NOT_READY");
    expect(result.reasons).toContain(reason);
  });

  it("keeps completion non-ready until reconciliation and relevant coverage are clean", () => {
    expect(evaluateGlobalSyncBackfillReadiness({
      ...base, request: { ...base.request, reconciliationGap: 1 },
    }).state).toBe("NOT_READY");
    expect(evaluateGlobalSyncBackfillReadiness({
      ...base, request: { ...base.request, quarantineUnresolved: null },
    }).state).toBe("NOT_READY");
    expect(evaluateGlobalSyncBackfillReadiness({
      ...base, request: { ...base.request, quarantineUnresolved: 1 },
    }).state).toBe("NOT_READY");
  });

  it("shows unrelated quarantine but does not block the current range", () => {
    expect(evaluateGlobalSyncBackfillReadiness({
      ...base, agent: { ...base.agent, quarantineTotalCount: 99 },
    }).state).toBe("READY");
  });
});
