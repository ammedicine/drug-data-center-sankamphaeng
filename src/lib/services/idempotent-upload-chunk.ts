import { AgentAuthError } from "@/lib/agent-auth/verify";
import { db } from "@/lib/db";
import { syncBatches, syncUploadReceipts } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import {
  syncUploadPayloadSha256,
  type DrugMasterRecord,
  type DrugUsageRecord,
  type SyncUploadResponse,
} from "@/lib/shared/canonical";
import { and, eq, sql } from "drizzle-orm";

export type UploadChunkReceiptStatus = "PROCESSING" | "COMPLETED";

export interface UploadChunkBatch {
  id: string;
  agentId: string;
  facilityId: string;
  status: "STARTED" | "UPLOADING" | "COMPLETED" | "FAILED" | "ABORTED";
}

export interface UploadChunkReceipt {
  agentId: string;
  batchId: string;
  chunkRef: string;
  payloadSha256: string;
  status: UploadChunkReceiptStatus;
  result: SyncUploadResponse | null;
}

export interface IdempotentUploadChunkTransaction<TContext> {
  context: TContext;
  findBatch(agentId: string, batchRef: string): Promise<UploadChunkBatch | null>;
  claimReceipt(input: {
    agentId: string;
    batchId: string;
    chunkRef: string;
    payloadSha256: string;
  }): Promise<{ created: boolean; receipt: UploadChunkReceipt }>;
  completeReceipt(receipt: UploadChunkReceipt, result: SyncUploadResponse): Promise<void>;
}

export interface IdempotentUploadChunkStore<TContext> {
  transaction<T>(
    work: (transaction: IdempotentUploadChunkTransaction<TContext>) => Promise<T>,
  ): Promise<T>;
}

export class ChunkBatchAccessError extends AgentAuthError {
  constructor() {
    super(404, "BATCH_NOT_FOUND", "Sync batch was not started by this Agent");
    this.name = "ChunkBatchAccessError";
  }
}

export class ChunkBatchClosedError extends AgentAuthError {
  constructor() {
    super(409, "BATCH_CLOSED", "Sync batch is already closed");
    this.name = "ChunkBatchClosedError";
  }
}

export class ChunkPayloadConflictError extends AgentAuthError {
  constructor() {
    super(409, "CHUNK_PAYLOAD_CONFLICT", "chunkRef was already used with a different payload");
    this.name = "ChunkPayloadConflictError";
  }
}

export class ChunkInProgressError extends AgentAuthError {
  readonly retryAfterSeconds = 45;

  constructor() {
    super(503, "CHUNK_IN_PROGRESS", "This upload chunk is still being processed");
    this.name = "ChunkInProgressError";
  }
}

export class ChunkIdentityValidationError extends AgentAuthError {
  constructor() {
    super(422, "INVALID_CHUNK_IDENTITY", "chunkRef or payloadSha256 is invalid");
    this.name = "ChunkIdentityValidationError";
  }
}

export class ChunkPayloadHashMismatchError extends AgentAuthError {
  constructor() {
    super(422, "CHUNK_PAYLOAD_HASH_MISMATCH", "payloadSha256 does not match the upload payload");
    this.name = "ChunkPayloadHashMismatchError";
  }
}

function validateIdentity(chunkRef: string, payloadSha256: string): void {
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(chunkRef) || !/^[0-9a-f]{64}$/.test(payloadSha256)) {
    throw new ChunkIdentityValidationError();
  }
}

export function resolveUploadChunkIdentity(input: {
  batchRef: string;
  chunkRef?: string;
  payloadSha256?: string;
  pcucode: string;
  sourceVersion: string | null;
  drugs?: DrugMasterRecord[];
  records: DrugUsageRecord[];
}): { chunkRef: string; payloadSha256: string } | null {
  if (input.chunkRef === undefined && input.payloadSha256 === undefined) return null;
  if (input.chunkRef === undefined || input.payloadSha256 === undefined) {
    throw new ChunkIdentityValidationError();
  }
  validateIdentity(input.chunkRef, input.payloadSha256);
  const computed = syncUploadPayloadSha256(input);
  if (computed !== input.payloadSha256) throw new ChunkPayloadHashMismatchError();
  return { chunkRef: input.chunkRef, payloadSha256: computed };
}

export function createIdempotentUploadChunkProcessor<TContext>(
  store: IdempotentUploadChunkStore<TContext>,
) {
  return {
    async process(
      input: {
        agent: { agentId: string; facilityId: string };
        batchRef: string;
        chunkRef: string;
        payloadSha256: string;
      },
      processOnce: (context: TContext, batchId: string) => Promise<SyncUploadResponse>,
    ): Promise<SyncUploadResponse> {
      validateIdentity(input.chunkRef, input.payloadSha256);

      return store.transaction(async (transaction) => {
        const batch = await transaction.findBatch(input.agent.agentId, input.batchRef);
        if (!batch || batch.facilityId !== input.agent.facilityId) throw new ChunkBatchAccessError();

        const claim = await transaction.claimReceipt({
          agentId: input.agent.agentId,
          batchId: batch.id,
          chunkRef: input.chunkRef,
          payloadSha256: input.payloadSha256,
        });
        if (claim.receipt.payloadSha256 !== input.payloadSha256) {
          throw new ChunkPayloadConflictError();
        }
        if (!claim.created) {
          if (claim.receipt.status === "COMPLETED" && claim.receipt.result) {
            return structuredClone(claim.receipt.result);
          }
          throw new ChunkInProgressError();
        }
        if (batch.status === "COMPLETED" || batch.status === "FAILED" || batch.status === "ABORTED") {
          throw new ChunkBatchClosedError();
        }

        const result = await processOnce(transaction.context, batch.id);
        await transaction.completeReceipt(claim.receipt, result);
        return result;
      });
    },
  };
}

export type UploadChunkDatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const drizzleUploadChunkStore: IdempotentUploadChunkStore<UploadChunkDatabaseTransaction> = {
  async transaction(work) {
    return db.transaction(async (tx) =>
      work({
        context: tx,
        findBatch: async (agentId, batchRef) => {
          const [row] = await tx
            .select({
              id: syncBatches.id,
              agentId: syncBatches.agentId,
              facilityId: syncBatches.facilityId,
              status: syncBatches.status,
            })
            .from(syncBatches)
            .where(and(eq(syncBatches.agentId, agentId), eq(syncBatches.batchRef, batchRef)))
            .limit(1)
            .for("update");
          return row ?? null;
        },
        claimReceipt: async (input) => {
          const candidateId = newId();
          await tx
            .insert(syncUploadReceipts)
            .values({
              id: candidateId,
              agentId: input.agentId,
              batchId: input.batchId,
              chunkRef: input.chunkRef,
              payloadSha256: input.payloadSha256,
              status: "PROCESSING",
            })
            .onDuplicateKeyUpdate({ set: { id: sql`${syncUploadReceipts.id}` } });

          const [row] = await tx
            .select({
              id: syncUploadReceipts.id,
              agentId: syncUploadReceipts.agentId,
              batchId: syncUploadReceipts.batchId,
              chunkRef: syncUploadReceipts.chunkRef,
              payloadSha256: syncUploadReceipts.payloadSha256,
              status: syncUploadReceipts.status,
              result: syncUploadReceipts.result,
            })
            .from(syncUploadReceipts)
            .where(
              and(
                eq(syncUploadReceipts.agentId, input.agentId),
                eq(syncUploadReceipts.batchId, input.batchId),
                eq(syncUploadReceipts.chunkRef, input.chunkRef),
              ),
            )
            .limit(1)
            .for("update");
          if (!row) throw new Error("Upload receipt claim was not persisted");
          return {
            created: row.id === candidateId,
            receipt: {
              agentId: row.agentId,
              batchId: row.batchId,
              chunkRef: row.chunkRef,
              payloadSha256: row.payloadSha256,
              status: row.status,
              result: row.result ?? null,
            },
          };
        },
        completeReceipt: async (receipt, result) => {
          await tx
            .update(syncUploadReceipts)
            .set({
              status: "COMPLETED",
              acceptedCount: result.accepted,
              rejectedCount: result.rejected,
              result,
              completedAt: new Date(),
            })
            .where(
              and(
                eq(syncUploadReceipts.agentId, receipt.agentId),
                eq(syncUploadReceipts.batchId, receipt.batchId),
                eq(syncUploadReceipts.chunkRef, receipt.chunkRef),
              ),
            );
        },
      }),
    );
  },
};

export const idempotentUploadChunkProcessor = createIdempotentUploadChunkProcessor(
  drizzleUploadChunkStore,
);
