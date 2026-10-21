/**
 * Offline queue (PROJECT_SPEC section 14).
 *
 * Design choice: plain JSON chunk files on disk instead of SQLite. The agent
 * runs on whatever Windows/Node build a รพ.สต. happens to have, and a native
 * SQLite binding is the most common install failure; a directory of chunk files
 * is resumable, crash-safe (write-temp-then-rename) and inspectable by an
 * operator without extra tooling.
 *
 * Layout:  <data>/queue/pending/<batchRef>__<seq>.json
 *          <data>/queue/failed/<batchRef>__<seq>.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { syncUploadPayloadSha256, type DrugUsageRecord } from "@shared/canonical";
import { isBelowSyncFloor } from "@shared/sync-control";

export type ChunkStatus = "PENDING" | "FAILED";

export interface QueuedChunk {
  file: string;
  batchRef: string;
  sequence: number;
  pcucode: string;
  sourceVersion: string | null;
  records: DrugUsageRecord[];
  chunkRef?: string;
  payloadSha256?: string;
  attempts: number;
  lastError?: string | null;
}

interface AcknowledgedChunkReceipt {
  batchRef: string;
  sequence: number;
  chunkRef: string;
  payloadSha256: string;
  records: number;
  acknowledgedAt: string;
}

export interface QuarantineSummary {
  total: number;
  covered: number;
  unresolved: number;
}

export interface QuarantineCoverageInput {
  requestId: string;
  batchRef: string;
  pcucode: string;
  from: string;
  to: string;
  coveredAt: string;
}

interface QuarantinedPayload {
  pcucode?: string;
  records?: Array<{ usageDate?: string }>;
  coverage?: {
    requestId: string;
    coveredByBatchRef: string;
    coveredAt: string;
    coveredRange: { from: string; to: string };
  };
  [key: string]: unknown;
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class OfflineQueue {
  private readonly root: string;

  constructor(dataDirectory: string) {
    this.root = ensure(resolve(dataDirectory, "queue"));
    ensure(this.pendingDir());
    ensure(this.failedDir());
    ensure(this.receiptsDir());
  }

  private pendingDir(): string {
    return join(this.root, "pending");
  }

  private failedDir(): string {
    return join(this.root, "failed");
  }

  private receiptsDir(): string {
    return join(this.root, "receipts");
  }

  private receiptPath(batchRef: string, sequence: number): string {
    return join(this.receiptsDir(), `${batchRef}__${String(sequence).padStart(6, "0")}.json`);
  }

  /**
   * Rows the centre will no longer take, kept rather than thrown away.
   *
   * When a สถานบริการ's collection floor moves forward, chunks already on disk
   * can contain dispensing from before it. Uploading them would put back
   * exactly what the floor exists to keep out; deleting them would destroy
   * local work with nothing to show for it. So they are set aside, where an
   * operator can see how much there was and the rows are still readable if the
   * floor is ever lowered again.
   *
   * This is sync-derived local state - a copy of what JHCIS already holds -
   * and nothing here is authoritative. JHCIS is never touched.
   */
  private quarantineDir(): string {
    return join(this.root, "quarantined");
  }

  private pathFor(status: ChunkStatus, batchRef: string, sequence: number): string {
    const dir = status === "PENDING" ? this.pendingDir() : this.failedDir();
    return join(dir, `${batchRef}__${String(sequence).padStart(6, "0")}.json`);
  }

  /** Persists a chunk before it is uploaded, so a crash never loses data. */
  enqueue(chunk: Omit<QueuedChunk, "file" | "attempts">): string {
    const target = this.pathFor("PENDING", chunk.batchRef, chunk.sequence);
    const receiptFile = this.receiptPath(chunk.batchRef, chunk.sequence);
    if (existsSync(receiptFile)) {
      let receipt: AcknowledgedChunkReceipt;
      try {
        receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as AcknowledgedChunkReceipt;
      } catch {
        throw new Error(`Acknowledged chunk receipt is unreadable (${receiptFile})`);
      }
      const incomingHash = syncUploadPayloadSha256(chunk);
      const expectedChunkRef = `${chunk.batchRef}:${String(chunk.sequence).padStart(6, "0")}`;
      if (
        receipt.batchRef !== chunk.batchRef ||
        receipt.sequence !== chunk.sequence ||
        receipt.chunkRef !== expectedChunkRef ||
        receipt.payloadSha256 !== incomingHash
      ) {
        throw new Error(
          `Acknowledged chunk payload changed during recovery (${chunk.batchRef}:${chunk.sequence})`,
        );
      }
      return receiptFile;
    }
    if (existsSync(target)) {
      const existing = this.read(target);
      if (!existing) throw new Error(`Queued chunk is unreadable (${target})`);
      const existingHash = syncUploadPayloadSha256(existing);
      const incomingHash = syncUploadPayloadSha256(chunk);
      if (existingHash !== incomingHash) {
        throw new Error(`Queued chunk payload changed during recovery (${chunk.batchRef}:${chunk.sequence})`);
      }
      return target;
    }
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...chunk, attempts: 0 }), "utf8");
    renameSync(temp, target); // atomic on the same volume
    return target;
  }

  /**
   * Gives a durable queue item its protocol identity before its first request.
   * Existing v1.1.16 files are upgraded in place with the same temp+rename
   * guarantee as every other queue mutation.
   */
  prepareForUpload(chunk: QueuedChunk): QueuedChunk & {
    chunkRef: string;
    payloadSha256: string;
  } {
    const chunkRef = chunk.chunkRef ?? `${chunk.batchRef}:${String(chunk.sequence).padStart(6, "0")}`;
    const payloadSha256 = syncUploadPayloadSha256({
      batchRef: chunk.batchRef,
      pcucode: chunk.pcucode,
      sourceVersion: chunk.sourceVersion,
      records: chunk.records,
    });
    if (chunk.payloadSha256 && chunk.payloadSha256 !== payloadSha256) {
      throw new Error(`Queued chunk payload changed after identity was persisted (${chunkRef})`);
    }
    if (chunk.chunkRef === chunkRef && chunk.payloadSha256 === payloadSha256) {
      return chunk as QueuedChunk & { chunkRef: string; payloadSha256: string };
    }

    const next = { ...chunk, chunkRef, payloadSha256 };
    const temp = `${chunk.file}.tmp`;
    const { file: _file, ...payload } = next;
    void _file;
    writeFileSync(temp, JSON.stringify(payload), "utf8");
    renameSync(temp, chunk.file);
    return next;
  }

  private read(file: string): QueuedChunk | null {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Omit<QueuedChunk, "file">;
      return { ...raw, file };
    } catch {
      return null;
    }
  }

  list(status: ChunkStatus = "PENDING"): QueuedChunk[] {
    const dir = status === "PENDING" ? this.pendingDir() : this.failedDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.read(join(dir, name)))
      .filter((chunk): chunk is QueuedChunk => chunk !== null);
  }

  count(status: ChunkStatus = "PENDING"): number {
    const dir = status === "PENDING" ? this.pendingDir() : this.failedDir();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  }

  /**
   * Chunk uploaded successfully. Keep a small durable identity receipt until
   * the whole batch is completed, so re-reading after a mid-extraction crash
   * cannot mint a second chunk identity for rows Central already accepted.
   */
  ack(chunk: QueuedChunk): void {
    const prepared = this.prepareForUpload(chunk);
    const target = this.receiptPath(prepared.batchRef, prepared.sequence);
    if (existsSync(target)) {
      let existing: AcknowledgedChunkReceipt;
      try {
        existing = JSON.parse(readFileSync(target, "utf8")) as AcknowledgedChunkReceipt;
      } catch {
        throw new Error(`Acknowledged chunk receipt is unreadable (${target})`);
      }
      if (
        existing.chunkRef !== prepared.chunkRef ||
        existing.payloadSha256 !== prepared.payloadSha256
      ) {
        throw new Error(`Acknowledged chunk receipt conflicts with upload (${prepared.chunkRef})`);
      }
      rmSync(prepared.file, { force: true });
      return;
    }
    const temp = `${target}.tmp`;
    const receipt: AcknowledgedChunkReceipt = {
      batchRef: prepared.batchRef,
      sequence: prepared.sequence,
      chunkRef: prepared.chunkRef,
      payloadSha256: prepared.payloadSha256,
      records: prepared.records.length,
      acknowledgedAt: new Date().toISOString(),
    };
    writeFileSync(temp, JSON.stringify(receipt), "utf8");
    renameSync(temp, target);
    rmSync(prepared.file, { force: true });
  }

  /** Remove local receipts only after Central completion and local watermark durability. */
  clearReceipts(batchRef: string): void {
    const prefix = `${batchRef}__`;
    for (const name of readdirSync(this.receiptsDir())) {
      if (name.startsWith(prefix) && name.endsWith(".json")) {
        rmSync(join(this.receiptsDir(), name), { force: true });
      }
    }
  }

  /** Upload failed - keep it pending (retryable) or park it in failed/. */
  fail(chunk: QueuedChunk, error: string, permanent = false): void {
    const next = { ...chunk, attempts: chunk.attempts + 1, lastError: error.slice(0, 500) };
    const target = permanent
      ? this.pathFor("FAILED", chunk.batchRef, chunk.sequence)
      : chunk.file;
    const temp = `${target}.tmp`;
    const { file: _file, ...payload } = next;
    writeFileSync(temp, JSON.stringify(payload), "utf8");
    renameSync(temp, target);
    if (permanent && target !== chunk.file) rmSync(chunk.file, { force: true });
  }

  /**
   * Removes records below the floor from a chunk, keeping them on disk.
   *
   * Returns how many were set aside. A chunk left with nothing stays out of
   * the pending queue entirely; one with rows on both sides of the floor is
   * rewritten to hold only what may still be sent, so a partial chunk is never
   * uploaded whole and never silently trimmed without a record of it.
   */
  quarantineBelowFloor(chunk: QueuedChunk, floor: string): { kept: number; setAside: number } {
    const keep = chunk.records.filter((r) => !isBelowSyncFloor(r.usageDate, floor));
    const drop = chunk.records.filter((r) => isBelowSyncFloor(r.usageDate, floor));
    if (!drop.length) return { kept: keep.length, setAside: 0 };

    ensure(this.quarantineDir());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const parked = join(
      this.quarantineDir(),
      `${chunk.batchRef}__${String(chunk.sequence).padStart(6, "0")}__${stamp}.json`,
    );
    const temp = `${parked}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({
        batchRef: chunk.batchRef,
        sequence: chunk.sequence,
        pcucode: chunk.pcucode,
        sourceVersion: chunk.sourceVersion,
        floor,
        parkedAt: new Date().toISOString(),
        records: drop,
      }),
      "utf8",
    );
    renameSync(temp, parked);

    if (!keep.length) {
      rmSync(chunk.file, { force: true });
    } else {
      const target = chunk.file;
      const rewrite = `${target}.tmp`;
      const { file: _file, ...rest } = chunk;
      writeFileSync(rewrite, JSON.stringify({ ...rest, records: keep }), "utf8");
      renameSync(rewrite, target);
    }
    return { kept: keep.length, setAside: drop.length };
  }

  /** Applies a newly raised floor to every pending chunk without reading JHCIS. */
  quarantinePendingBelowFloor(floor: string): { chunks: number; records: number } {
    let chunks = 0;
    let records = 0;
    for (const chunk of this.list("PENDING")) {
      const result = this.quarantineBelowFloor(chunk, floor);
      if (result.setAside) chunks += 1;
      records += result.setAside;
    }
    return { chunks, records };
  }

  /** How many chunks are parked below the floor, for the screen. */
  quarantinedCount(): number {
    const dir = this.quarantineDir();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  }

  quarantineSummary(): QuarantineSummary {
    const dir = this.quarantineDir();
    const files = existsSync(dir)
      ? readdirSync(dir).filter((file) => file.endsWith(".json"))
      : [];
    let covered = 0;
    for (const name of files) {
      try {
        const payload = JSON.parse(readFileSync(join(dir, name), "utf8")) as QuarantinedPayload;
        if (
          payload.coverage?.requestId &&
          payload.coverage.coveredByBatchRef &&
          payload.coverage.coveredAt &&
          payload.coverage.coveredRange?.from &&
          payload.coverage.coveredRange.to
        ) covered += 1;
      } catch {
        // Unreadable evidence is unresolved, never silently healthy.
      }
    }
    return { total: files.length, covered, unresolved: files.length - covered };
  }

  /** Adds proof to fully covered files without moving, deleting, or changing records. */
  markQuarantineCovered(input: QuarantineCoverageInput): {
    covered: number;
    unresolvedRelevant: number;
  } {
    const dir = this.quarantineDir();
    if (!existsSync(dir)) return { covered: 0, unresolvedRelevant: 0 };
    const wanted = {
      requestId: input.requestId,
      coveredByBatchRef: input.batchRef,
      coveredAt: input.coveredAt,
      coveredRange: { from: input.from, to: input.to },
    };
    let covered = 0;
    let unresolvedRelevant = 0;
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
      const path = join(dir, name);
      let payload: QuarantinedPayload;
      try {
        payload = JSON.parse(readFileSync(path, "utf8")) as QuarantinedPayload;
      } catch {
        unresolvedRelevant += 1;
        continue;
      }
      if (payload.pcucode !== input.pcucode || !Array.isArray(payload.records)) continue;
      const dates = payload.records.map((record) => record.usageDate);
      if (!dates.length || dates.some((date) => typeof date !== "string")) {
        unresolvedRelevant += 1;
        continue;
      }
      const overlaps = dates.some((date) => date! >= input.from && date! <= input.to);
      const fullyCovered = dates.every((date) => date! >= input.from && date! <= input.to);
      if (!overlaps) continue;
      if (!fullyCovered) {
        unresolvedRelevant += 1;
        continue;
      }
      if (payload.coverage) {
        if (
          payload.coverage.requestId === wanted.requestId &&
          payload.coverage.coveredByBatchRef === wanted.coveredByBatchRef &&
          payload.coverage.coveredRange.from === wanted.coveredRange.from &&
          payload.coverage.coveredRange.to === wanted.coveredRange.to
        ) {
          covered += 1;
          continue;
        }
        throw new Error(`Quarantine coverage conflict (${name})`);
      }
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, JSON.stringify({ ...payload, coverage: wanted }), "utf8");
      renameSync(temp, path);
      covered += 1;
    }
    return { covered, unresolvedRelevant };
  }

  /**
   * Re-files a chunk under a different batch.
   *
   * A chunk whose batch the server has already closed can never be delivered
   * as it stands, and its rows would sit in failed/ forever. Re-homing keeps
   * the data and lets a fresh batch carry it.
   */
  rehome(chunk: QueuedChunk, batchRef: string, sequence: number): string {
    const target = this.pathFor("PENDING", batchRef, sequence);
    const temp = `${target}.tmp`;
    const { file: _file, ...payload } = chunk;
    writeFileSync(temp, JSON.stringify({ ...payload, batchRef, sequence, attempts: 0 }), "utf8");
    renameSync(temp, target);
    rmSync(chunk.file, { force: true });
    return target;
  }

  /** Moves parked chunks back into the pending queue (sdc-agent retry). */
  requeueFailed(): number {
    const failed = this.list("FAILED");
    for (const chunk of failed) {
      const target = this.pathFor("PENDING", chunk.batchRef, chunk.sequence);
      renameSync(chunk.file, target);
    }
    return failed.length;
  }
}
