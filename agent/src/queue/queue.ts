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

import type { DrugUsageRecord } from "@shared/canonical";

export type ChunkStatus = "PENDING" | "FAILED";

export interface QueuedChunk {
  file: string;
  batchRef: string;
  sequence: number;
  pcucode: string;
  sourceVersion: string | null;
  records: DrugUsageRecord[];
  attempts: number;
  lastError?: string | null;
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
  }

  private pendingDir(): string {
    return join(this.root, "pending");
  }

  private failedDir(): string {
    return join(this.root, "failed");
  }

  private pathFor(status: ChunkStatus, batchRef: string, sequence: number): string {
    const dir = status === "PENDING" ? this.pendingDir() : this.failedDir();
    return join(dir, `${batchRef}__${String(sequence).padStart(6, "0")}.json`);
  }

  /** Persists a chunk before it is uploaded, so a crash never loses data. */
  enqueue(chunk: Omit<QueuedChunk, "file" | "attempts">): string {
    const target = this.pathFor("PENDING", chunk.batchRef, chunk.sequence);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...chunk, attempts: 0 }), "utf8");
    renameSync(temp, target); // atomic on the same volume
    return target;
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

  /** Chunk uploaded successfully - drop it. */
  ack(chunk: QueuedChunk): void {
    rmSync(chunk.file, { force: true });
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
