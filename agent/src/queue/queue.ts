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
import { isBelowSyncFloor } from "@shared/sync-control";

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

  /** How many chunks are parked below the floor, for the screen. */
  quarantinedCount(): number {
    const dir = this.quarantineDir();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
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
