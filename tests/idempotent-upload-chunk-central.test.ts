import { describe, expect, it } from "vitest";

import {
  ChunkBatchAccessError,
  ChunkPayloadConflictError,
  ChunkPayloadHashMismatchError,
  createIdempotentUploadChunkProcessor,
  resolveUploadChunkIdentity,
  type IdempotentUploadChunkStore,
  type IdempotentUploadChunkTransaction,
  type UploadChunkBatch,
  type UploadChunkReceipt,
} from "@/lib/services/idempotent-upload-chunk";
import { syncUploadPayloadSha256, type SyncUploadResponse } from "@/lib/shared/canonical";

interface State {
  receipts: Map<string, UploadChunkReceipt>;
  counters: { sent: number; accepted: number; rejected: number };
  facts: Set<string>;
  rejects: string[];
}

function cloneState(source: State): State {
  return {
    receipts: new Map([...source.receipts].map(([key, value]) => [key, structuredClone(value)])),
    counters: { ...source.counters },
    facts: new Set(source.facts),
    rejects: [...source.rejects],
  };
}

class MemoryStore implements IdempotentUploadChunkStore<State> {
  state: State = {
    receipts: new Map(),
    counters: { sent: 0, accepted: 0, rejected: 0 },
    facts: new Set(),
    rejects: [],
  };
  batches: UploadChunkBatch[] = [
    { id: "batch-a", agentId: "agent-a", facilityId: "facility-a", status: "UPLOADING" },
  ];
  private tail: Promise<void> = Promise.resolve();

  async transaction<T>(
    work: (transaction: IdempotentUploadChunkTransaction<State>) => Promise<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = cloneState(this.state);
    try {
      return await work({
        context: this.state,
        findBatch: async (agentId, batchRef) =>
          this.batches.find((batch) => batch.agentId === agentId && batch.id === batchRef) ?? null,
        claimReceipt: async (input) => {
          const key = `${input.agentId}|${input.batchId}|${input.chunkRef}`;
          const existing = this.state.receipts.get(key);
          if (existing) return { created: false, receipt: existing };
          const receipt: UploadChunkReceipt = {
            ...input,
            status: "PROCESSING",
            result: null,
          };
          this.state.receipts.set(key, receipt);
          return { created: true, receipt };
        },
        completeReceipt: async (receipt, result) => {
          receipt.status = "COMPLETED";
          receipt.result = structuredClone(result);
        },
      });
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      release();
    }
  }
}

const result: SyncUploadResponse = {
  accepted: 2,
  rejected: 1,
  rejects: [{ recordKey: null, reason: "drugCode is required" }],
};

function input(payloadSha256 = "a".repeat(64)) {
  return {
    agent: { agentId: "agent-a", facilityId: "facility-a" },
    batchRef: "batch-a",
    chunkRef: "SYNC-A:000001",
    payloadSha256,
  };
}

function mutateOnce(state: State): SyncUploadResponse {
  state.facts.add("fact-1");
  state.facts.add("fact-2");
  state.rejects.push("drugCode is required");
  state.counters.sent += 3;
  state.counters.accepted += 2;
  state.counters.rejected += 1;
  return structuredClone(result);
}

describe("transactional upload chunk receipts", () => {
  it("processes the first chunk once and returns the stored result after a lost response", async () => {
    const store = new MemoryStore();
    const processor = createIdempotentUploadChunkProcessor(store);
    let calls = 0;
    const process = async (state: State) => {
      calls += 1;
      return mutateOnce(state);
    };

    expect(await processor.process(input(), process)).toEqual(result);
    expect(await processor.process(input(), process)).toEqual(result);
    expect(calls).toBe(1);
    expect(store.state.counters).toEqual({ sent: 3, accepted: 2, rejected: 1 });
    expect(store.state.rejects).toEqual(["drugCode is required"]);
  });

  it("replays a completed receipt after the batch closes, but rejects a new chunk", async () => {
    const store = new MemoryStore();
    const processor = createIdempotentUploadChunkProcessor(store);
    let calls = 0;
    const process = async (state: State) => {
      calls += 1;
      return mutateOnce(state);
    };

    expect(await processor.process(input(), process)).toEqual(result);
    store.batches[0] = { ...store.batches[0], status: "COMPLETED" };

    expect(await processor.process(input(), process)).toEqual(result);
    await expect(
      processor.process({ ...input(), chunkRef: "SYNC-A:000002" }, process),
    ).rejects.toMatchObject({ code: "BATCH_CLOSED" });
    expect(calls).toBe(1);
  });

  it("rejects reuse of a chunkRef with a different payload hash without mutation", async () => {
    const store = new MemoryStore();
    const processor = createIdempotentUploadChunkProcessor(store);
    await processor.process(input(), async (state) => mutateOnce(state));
    const before = cloneState(store.state);

    await expect(
      processor.process(input("b".repeat(64)), async (state) => mutateOnce(state)),
    ).rejects.toBeInstanceOf(ChunkPayloadConflictError);
    expect(store.state).toEqual(before);
  });

  it("serializes concurrent duplicate uploads and commits processing once", async () => {
    const store = new MemoryStore();
    const processor = createIdempotentUploadChunkProcessor(store);
    let calls = 0;
    const process = async (state: State) => {
      calls += 1;
      await Promise.resolve();
      return mutateOnce(state);
    };

    const [first, second] = await Promise.all([
      processor.process(input(), process),
      processor.process(input(), process),
    ]);
    expect(first).toEqual(result);
    expect(second).toEqual(result);
    expect(calls).toBe(1);
    expect(store.state.counters.sent).toBe(3);
  });

  it("keeps an unproven in-progress receipt retryable without processing", async () => {
    const store = new MemoryStore();
    const processor = createIdempotentUploadChunkProcessor(store);
    store.state.receipts.set("agent-a|batch-a|SYNC-A:000001", {
      agentId: "agent-a",
      batchId: "batch-a",
      chunkRef: "SYNC-A:000001",
      payloadSha256: "a".repeat(64),
      status: "PROCESSING",
      result: null,
    });

    let called = false;
    await expect(
      processor.process(input(), async () => {
        called = true;
        return result;
      }),
    ).rejects.toMatchObject({
      code: "CHUNK_IN_PROGRESS",
      status: 503,
      retryAfterSeconds: 45,
    });
    expect(called).toBe(false);
    expect(store.state.receipts.size).toBe(1);
  });

  it("rolls back facts, rejects, counters, and the receipt together", async () => {
    const store = new MemoryStore();
    const processor = createIdempotentUploadChunkProcessor(store);

    await expect(
      processor.process(input(), async (state) => {
        mutateOnce(state);
        throw new Error("database disconnected before commit");
      }),
    ).rejects.toThrow("database disconnected before commit");
    expect(store.state.receipts.size).toBe(0);
    expect(store.state.facts.size).toBe(0);
    expect(store.state.rejects).toHaveLength(0);
    expect(store.state.counters).toEqual({ sent: 0, accepted: 0, rejected: 0 });

    expect(await processor.process(input(), async (state) => mutateOnce(state))).toEqual(result);
    expect(store.state.receipts.size).toBe(1);
  });

  it("derives batch and facility scope from the authenticated Agent", async () => {
    const store = new MemoryStore();
    const processor = createIdempotentUploadChunkProcessor(store);
    const called: string[] = [];

    await expect(
      processor.process(
        { ...input(), agent: { agentId: "agent-b", facilityId: "facility-a" } },
        async () => {
          called.push("cross-agent");
          return result;
        },
      ),
    ).rejects.toBeInstanceOf(ChunkBatchAccessError);

    store.batches[0] = { ...store.batches[0], facilityId: "facility-b" };
    await expect(
      processor.process(input(), async () => {
        called.push("cross-facility");
        return result;
      }),
    ).rejects.toBeInstanceOf(ChunkBatchAccessError);
    expect(called).toEqual([]);
    expect(store.state.receipts.size).toBe(0);
  });
});

describe("upload receipt API boundary", () => {
  const body = {
    batchRef: "SYNC-A",
    pcucode: "05957",
    sourceVersion: null,
    records: [
      {
        visitNo: 1001,
        drugCode: "D1",
        drugName: "ยา",
        drugType: "01",
        quantity: 1,
        unit: "เม็ด",
        unitCode: "027",
        clinic: null,
        usageDate: "2026-10-01",
      },
    ],
  };

  it("keeps an upload without chunk identity on the legacy path", () => {
    expect(resolveUploadChunkIdentity(body)).toBeNull();
  });

  it("recomputes and verifies the payload hash on Central", () => {
    const payloadSha256 = syncUploadPayloadSha256(body);
    expect(
      resolveUploadChunkIdentity({ ...body, chunkRef: "SYNC-A:000001", payloadSha256 }),
    ).toEqual({ chunkRef: "SYNC-A:000001", payloadSha256 });
    expect(() =>
      resolveUploadChunkIdentity({
        ...body,
        chunkRef: "SYNC-A:000001",
        payloadSha256: "f".repeat(64),
      }),
    ).toThrow(ChunkPayloadHashMismatchError);
  });

  it("hashes semantic fields rather than JavaScript object property order", () => {
    const reordered = {
      ...body,
      records: body.records.map((record) => ({
        usageDate: record.usageDate,
        clinic: record.clinic,
        quantity: record.quantity,
        drugType: record.drugType,
        drugName: record.drugName,
        drugCode: record.drugCode,
        visitNo: record.visitNo,
        unitCode: record.unitCode,
        unit: record.unit,
        visitMissing: false,
      })),
    };

    expect(syncUploadPayloadSha256(reordered)).toBe(syncUploadPayloadSha256(body));
  });
});
