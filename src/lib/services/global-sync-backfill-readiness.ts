export type BackfillReadinessState = "READY" | "NOT_READY" | "UNKNOWN";

export type BackfillReadinessReason =
  | "NO_ACTIVE_PLAN"
  | "TELEMETRY_UNKNOWN"
  | "TELEMETRY_STALE"
  | "REQUEST_EVIDENCE_MISMATCH"
  | "CAPABILITY_REQUIRED"
  | "POLICY_REVISION_MISMATCH"
  | "PAUSE_REQUIRED"
  | "EFFECTIVE_PAUSE_REQUIRED"
  | "ACTIVE_BATCH"
  | "MANUAL_REQUEST"
  | "PENDING_QUEUE"
  | "FAILED_QUEUE"
  | "REQUEST_OPEN"
  | "REQUEST_FAILED"
  | "RECONCILIATION_GAP"
  | "COVERAGE_PENDING"
  | "QUARANTINE_UNRESOLVED"
  | "CURRENT_ERROR";

export interface GlobalSyncBackfillReadinessInput {
  now: Date;
  freshnessMs?: number;
  policy: {
    activeRevision: number;
    backfillPlan: {
      policyRevision: number;
      from: string;
      to: string;
      status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "SUPERSEDED";
    } | null;
  } | null;
  agent: {
    capabilities: { remoteSyncStartDate: boolean; idempotentUploadChunk: boolean };
    appliedPolicyRevision: number | null;
    desiredSyncState: "RUNNING" | "PAUSED";
    effectiveSyncState: "RUNNING" | "PAUSE_REQUESTED" | "PAUSED" | null;
    online: boolean;
    queuePendingCount: number | null;
    queueFailedCount: number | null;
    quarantineTotalCount: number | null;
    queueTelemetryAt: Date | null;
    hasActiveBatch: boolean;
    hasManualRequest: boolean;
    currentError: string | null;
  };
  request: {
    id: string;
    policyRevision: number;
    rangeFrom: string;
    rangeTo: string;
    status: "REQUESTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED";
    reconciliationGap: number | null;
    quarantineCovered: number | null;
    quarantineUnresolved: number | null;
  } | null;
}

export function evaluateGlobalSyncBackfillReadiness(
  input: GlobalSyncBackfillReadinessInput,
): { state: BackfillReadinessState; reasons: BackfillReadinessReason[] } {
  const plan = input.policy?.backfillPlan;
  if (!plan || plan.status !== "ACTIVE" || plan.policyRevision !== input.policy?.activeRevision) {
    return { state: "UNKNOWN", reasons: ["NO_ACTIVE_PLAN"] };
  }

  const known: BackfillReadinessReason[] = [];
  if (!input.agent.capabilities.remoteSyncStartDate || !input.agent.capabilities.idempotentUploadChunk) known.push("CAPABILITY_REQUIRED");
  if (input.agent.appliedPolicyRevision !== input.policy!.activeRevision) known.push("POLICY_REVISION_MISMATCH");
  if (input.agent.desiredSyncState !== "PAUSED") known.push("PAUSE_REQUIRED");
  if (input.agent.online && input.agent.effectiveSyncState !== "PAUSED") known.push("EFFECTIVE_PAUSE_REQUIRED");
  if (input.agent.hasActiveBatch) known.push("ACTIVE_BATCH");
  if (input.agent.hasManualRequest) known.push("MANUAL_REQUEST");
  if ((input.agent.queuePendingCount ?? 0) > 0) known.push("PENDING_QUEUE");
  if ((input.agent.queueFailedCount ?? 0) > 0) known.push("FAILED_QUEUE");
  if (input.agent.currentError) known.push("CURRENT_ERROR");

  const request = input.request;
  const requestMatches = Boolean(
    request &&
    request.policyRevision === input.policy!.activeRevision &&
    request.rangeFrom >= plan.from &&
    request.rangeTo <= plan.to &&
    request.rangeFrom <= request.rangeTo,
  );
  if (requestMatches && request) {
    if (request.status === "REQUESTED" || request.status === "IN_PROGRESS") known.push("REQUEST_OPEN");
    if (request.status === "FAILED" || request.status === "CANCELLED") known.push("REQUEST_FAILED");
    if (request.status === "COMPLETED" && request.reconciliationGap !== 0) known.push("RECONCILIATION_GAP");
    if (request.status === "COMPLETED" && request.quarantineUnresolved === null) known.push("COVERAGE_PENDING");
    if ((request.quarantineUnresolved ?? 0) > 0) known.push("QUARANTINE_UNRESOLVED");
  }
  if (known.length) return { state: "NOT_READY", reasons: [...new Set(known)] };

  if (!requestMatches) return { state: "UNKNOWN", reasons: ["REQUEST_EVIDENCE_MISMATCH"] };
  if (
    input.agent.queuePendingCount === null ||
    input.agent.queueFailedCount === null ||
    input.agent.quarantineTotalCount === null ||
    !input.agent.queueTelemetryAt
  ) return { state: "UNKNOWN", reasons: ["TELEMETRY_UNKNOWN"] };
  if (input.now.getTime() - input.agent.queueTelemetryAt.getTime() > (input.freshnessMs ?? 5 * 60_000)) {
    return { state: "UNKNOWN", reasons: ["TELEMETRY_STALE"] };
  }
  if (request?.status !== "COMPLETED") return { state: "NOT_READY", reasons: ["REQUEST_OPEN"] };
  return { state: "READY", reasons: [] };
}
