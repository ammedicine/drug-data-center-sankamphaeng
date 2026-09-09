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
import { execFileSync } from "node:child_process";
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

/* -------------------------------------------------------- one worker per home */

/**
 * The worker holds this for its whole life, not just while syncing.
 *
 * sync.lock serialises sync *runs*. Nothing stopped two `agent run` workers
 * existing at once against the same data directory: both would tick, both
 * would heartbeat, both would schedule, and only the moment they tried to sync
 * would one of them lose. Two heartbeats for one agent make the fleet page lie
 * about which one is current, and two schedulers double every request the
 * clinic makes.
 *
 * It happened for real. A tray was closed while its worker was mid-sync; the
 * worker survived as an orphan, and the next tray started a second one.
 */
interface WorkerLockFile {
  pid: number;
  hostname: string;
  startedAt: string;
  /** milliseconds since the epoch, from the OS, to survive pid reuse */
  processStartedAtMs: number | null;
  dataDir: string;
}

export function workerLockPath(): string {
  return resolve(dataDir(), "worker.lock");
}

/**
 * When the process holding a pid actually started.
 *
 * A pid on its own is not an identity: Windows reuses them, and a lock file
 * naming a pid that now belongs to Notepad would keep a clinic's agent from
 * ever starting again. Comparing start times makes the check specific to the
 * process that wrote the lock.
 */
function processStartedAtMs(pid: number): number | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; ` +
          "if ($p) { [int64]($p.StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds }",
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    ).trim();
    const value = Number(out);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export class WorkerAlreadyRunningError extends Error {
  constructor(readonly holder: WorkerLockFile) {
    super(
      `worker already running for data directory (pid ${holder.pid}, เริ่ม ${holder.startedAt})`,
    );
    this.name = "WorkerAlreadyRunningError";
  }
}

/**
 * Claims the right to be this data directory's worker.
 *
 * Scoped to the data directory, deliberately: fifteen รพ.สต. each have their
 * own, and on the test harness fifteen workers share one machine. A guard on
 * the machine rather than on the directory would break that.
 *
 * Returns a release function. Throws WorkerAlreadyRunningError when a live
 * worker already holds it - the caller exits, it does not take over. Killing
 * the incumbent would be a cure worse than the disease.
 */
export function acquireWorkerLock(): () => void {
  const path = workerLockPath();
  const existing = ((): WorkerLockFile | null => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as WorkerLockFile;
    } catch {
      return null;
    }
  })();

  if (existing) {
    const sameMachine = existing.hostname === hostname();
    const alive = sameMachine && processAlive(existing.pid);
    // A live pid is not enough. If the lock recorded when its process began,
    // the process holding that pid now has to be the same one.
    const startedNow = alive ? processStartedAtMs(existing.pid) : null;
    const sameProcess =
      existing.processStartedAtMs === null ||
      startedNow === null ||
      Math.abs(startedNow - existing.processStartedAtMs) < 2000;

    if (alive && sameProcess) throw new WorkerAlreadyRunningError(existing);

    log.warn("พบ worker.lock ที่ถูกทิ้งไว้ จะยึดมาใช้", {
      pid: existing.pid,
      processAlive: alive,
      samePid: sameProcess,
    });
  }

  const claim: WorkerLockFile = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    processStartedAtMs: processStartedAtMs(process.pid),
    dataDir: dataDir(),
  };
  writeFileSync(path, JSON.stringify(claim, null, 2), "utf8");

  return () => {
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as WorkerLockFile;
      // Only ever remove our own claim.
      if (current.pid === process.pid) unlinkSync(path);
    } catch {
      /* already gone, which is the outcome we wanted */
    }
  };
}
