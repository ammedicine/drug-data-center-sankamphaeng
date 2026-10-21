import { AgentAuthError } from "@/lib/agent-auth/verify";

export type NormalBatchStatus = "STARTED" | "UPLOADING" | "COMPLETED" | "FAILED" | "ABORTED";

export interface SyncCompletionBatch {
  id: string;
  agentId: string;
  facilityId: string;
  batchRef: string;
  status: NormalBatchStatus;
  rangeTo: string | null;
  completedAt: Date | null;
  recordsRead: number;
  recordsSent: number;
  recordsRejected: number;
  errorMessage: string | null;
}

export interface SyncCompletionPayload {
  authenticatedAgentId: string;
  authenticatedFacilityId: string;
  batchRef: string;
  status: "COMPLETED" | "FAILED" | "ABORTED";
  recordsRead: number;
  recordsSent: number;
  lastVisitDate: string | null;
  errorMessage?: string | null;
}

export class SyncCompletionConflictError extends AgentAuthError {
  constructor(message = "The completed batch does not match this completion request") {
    super(409, "SYNC_COMPLETION_CONFLICT", message);
    this.name = "SyncCompletionConflictError";
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function expectedWatermark(batch: SyncCompletionBatch): string | null {
  if (!batch.rangeTo) return null;
  const ceiling =
    batch.status === "COMPLETED" && batch.completedAt
      ? batch.completedAt.toISOString().slice(0, 10)
      : today();
  return batch.rangeTo < ceiling ? batch.rangeTo : ceiling;
}

/** Validates whether a normal completion is new or an exact safe replay. */
export function assessSyncCompletion(
  batch: SyncCompletionBatch,
  payload: SyncCompletionPayload,
): { replay: boolean } {
  if (
    batch.agentId !== payload.authenticatedAgentId ||
    batch.facilityId !== payload.authenticatedFacilityId ||
    batch.batchRef !== payload.batchRef
  ) {
    throw new SyncCompletionConflictError("Authenticated Agent or batch identity does not match");
  }

  if (batch.status === "STARTED" || batch.status === "UPLOADING") {
    if (
      payload.status === "COMPLETED" &&
      (payload.recordsRead !== batch.recordsRead ||
        payload.recordsSent !== batch.recordsSent ||
        payload.lastVisitDate !== expectedWatermark(batch) ||
        (payload.errorMessage ?? null) !== null)
    ) {
      throw new SyncCompletionConflictError("Completion payload does not match the open batch");
    }
    return { replay: false };
  }
  if (batch.status !== "COMPLETED") {
    throw new SyncCompletionConflictError(`Batch is already terminal (${batch.status})`);
  }

  if (
    payload.status !== "COMPLETED" ||
    payload.recordsRead !== batch.recordsRead ||
    payload.recordsSent !== batch.recordsSent ||
    payload.lastVisitDate !== expectedWatermark(batch) ||
    (payload.errorMessage ?? null) !== null ||
    batch.errorMessage !== null
  ) {
    throw new SyncCompletionConflictError();
  }
  return { replay: true };
}
