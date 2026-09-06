/**
 * One sync pipeline at a time, per machine.
 *
 * The tray can start `sdc-agent sync` in its own process while the background
 * `sdc-agent run` worker is midway through a scheduled run. The `running` flag
 * in cli.ts only guards the worker's own process, so nothing stopped the two
 * from interleaving - and they share every piece of mutable state the Agent
 * has: batchSequence, state.json, status.json and the offline queue. Two
 * writers there means a lost watermark or a duplicated batch reference.
 *
 * A file in the data directory is the lock. It has to survive the ways a
 * clinic PC actually dies - power cut, Windows restart, a killed process -
 * without leaving a machine that refuses to sync ever again, so the holder
 * writes its pid and refreshes a timestamp, and a lock whose owner is gone or
 * silent is taken over rather than obeyed.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { dataDir } from "./config";
import { log } from "./logger";

interface LockFile {
  pid: number;
  hostname: string;
  startedAt: string;
  /** refreshed while the holder works, so a dead holder can be spotted */
  heartbeatAt: string;
  label: string;
}

/** A lock not refreshed for this long is treated as abandoned. */
const STALE_AFTER_MS = 5 * 60_000;

/** How often the holder proves it is still alive. */
const REFRESH_MS = 30_000;

export function lockPath(): string {
  return resolve(dataDir(), "sync.lock");
}

function readLock(): LockFile | null {
  try {
    return JSON.parse(readFileSync(lockPath(), "utf8")) as LockFile;
  } catch {
    return null;
  }
}

/**
 * Whether a process is still alive.
 *
 * Signal 0 checks for existence without touching the process. EPERM means it
 * exists but belongs to someone else, which still counts as alive.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SyncLockedError extends Error {
  constructor(readonly holder: LockFile) {
    super(
      `กำลังซิงก์อยู่แล้วโดยโปรเซสอื่น (${holder.label}, pid ${holder.pid}, เริ่ม ${holder.startedAt})`,
    );
    this.name = "SyncLockedError";
  }
}

/**
 * Runs `work` while holding the lock, releasing it whatever happens.
 *
 * Throws SyncLockedError when another live process holds it. A lock left by a
 * process that no longer exists, or one that stopped refreshing, is taken
 * over: the alternative is a clinic whose agent never syncs again after a
 * power cut, which is worse than the race the lock exists to prevent.
 */
export async function withSyncLock<T>(
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const path = lockPath();
  const existing = readLock();

  if (existing) {
    const age = Date.now() - Date.parse(existing.heartbeatAt);
    const sameMachine = existing.hostname === hostname();
    const alive = sameMachine && processAlive(existing.pid);
    const fresh = Number.isFinite(age) && age < STALE_AFTER_MS;

    if (alive && fresh) throw new SyncLockedError(existing);

    log.warn("พบ sync.lock ที่ถูกทิ้งไว้ จะยึดมาใช้", {
      pid: existing.pid,
      label: existing.label,
      ageMs: Number.isFinite(age) ? age : null,
      processAlive: alive,
    });
  }

  const claim: LockFile = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    label,
  };
  writeFileSync(path, JSON.stringify(claim, null, 2), "utf8");

  const timer = setInterval(() => {
    try {
      writeFileSync(
        path,
        JSON.stringify(
          { ...claim, heartbeatAt: new Date().toISOString() },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // Losing the refresh is not a reason to abandon a sync in progress; the
      // worst case is another process deciding the lock is stale later.
    }
  }, REFRESH_MS);
  timer.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(timer);
    try {
      // Only remove the lock if it is still ours - a process that took over a
      // stale lock must not have it deleted from under it.
      const current = readLock();
      if (current?.pid === process.pid) unlinkSync(path);
    } catch {
      // An unlink that fails leaves a lock that the next run will find stale.
    }
  }
}
