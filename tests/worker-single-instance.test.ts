/**
 * One worker per data directory, and no more.
 *
 * sync.lock serialises sync *runs*. Nothing stopped two `agent run` workers
 * existing at once against the same data directory: both would tick, both
 * would heartbeat, both would schedule, and only the instant they tried to
 * sync would one of them lose. Two heartbeats for one agent make the fleet
 * page disagree with itself, and two schedulers double every request a clinic
 * makes.
 *
 * It happened. A tray was closed while its worker was mid-sync, the worker
 * carried on as an orphan, and the next tray started a second one.
 *
 * The guard is scoped to the data directory rather than the machine, because
 * fifteen สถานบริการ have fifteen of them - and the test harness runs fifteen
 * workers on this one PC. A machine-wide guard would break the fleet.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let homeA: string;
let homeB: string;

beforeEach(() => {
  homeA = mkdtempSync(resolve(tmpdir(), "sdc-worker-a-"));
  homeB = mkdtempSync(resolve(tmpdir(), "sdc-worker-b-"));
});

afterEach(() => {
  for (const home of [homeA, homeB]) rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

let counter = 0;
async function lockModule(home: string) {
  process.env.AGENT_DATA_DIR = home;
  return import(`../agent/src/lock?w=${counter++}`);
}

describe("the worker lock", () => {
  it("lets the first worker in", async () => {
    const { acquireWorkerLock, workerLockPath } = await lockModule(homeA);
    const release = acquireWorkerLock();
    expect(existsSync(workerLockPath())).toBe(true);

    const held = JSON.parse(readFileSync(workerLockPath(), "utf8"));
    expect(held.pid).toBe(process.pid);
    expect(held.dataDir).toBe(homeA);

    release();
    expect(existsSync(workerLockPath())).toBe(false);
  });

  it("TEST 23: refuses a second worker on the same data directory", async () => {
    const first = await lockModule(homeA);
    const release = first.acquireWorkerLock();

    // A second process, same home. It must decline - and it must not take the
    // lock away from the worker that is running.
    const second = await lockModule(homeA);
    expect(() => second.acquireWorkerLock()).toThrow(/already running/i);

    const still = JSON.parse(readFileSync(first.workerLockPath(), "utf8"));
    expect(still.pid).toBe(process.pid);
    release();
  });

  it("TEST 24: two different data directories run side by side", async () => {
    // The whole fleet depends on this: the guard is per home, not per machine.
    const a = await lockModule(homeA);
    const releaseA = a.acquireWorkerLock();
    const b = await lockModule(homeB);
    const releaseB = b.acquireWorkerLock();

    expect(existsSync(join(homeA, "worker.lock"))).toBe(true);
    expect(existsSync(join(homeB, "worker.lock"))).toBe(true);
    releaseA();
    releaseB();
  });

  it("takes over a lock whose owner is gone", async () => {
    // A power cut leaves a lock behind. A clinic must not need a person to
    // delete a file before its agent will ever run again.
    writeFileSync(
      join(homeA, "worker.lock"),
      JSON.stringify({
        pid: 999_999_999, // never a live pid
        hostname: require("node:os").hostname(),
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        processStartedAtMs: Date.now() - 3_600_000,
        dataDir: homeA,
      }),
      "utf8",
    );

    const { acquireWorkerLock, workerLockPath } = await lockModule(homeA);
    const release = acquireWorkerLock();
    expect(JSON.parse(readFileSync(workerLockPath(), "utf8")).pid).toBe(process.pid);
    release();
  });

  it("is not fooled by a reused pid", async () => {
    // The pid is alive - it is this very process - but it is not the process
    // that wrote the lock, which the recorded start time reveals. Treating a
    // recycled pid as the old holder would wedge the agent permanently.
    writeFileSync(
      join(homeA, "worker.lock"),
      JSON.stringify({
        pid: process.pid,
        hostname: require("node:os").hostname(),
        startedAt: "2020-01-01T00:00:00.000Z",
        processStartedAtMs: 1_577_836_800_000, // long before this process began
        dataDir: homeA,
      }),
      "utf8",
    );

    const { acquireWorkerLock, workerLockPath } = await lockModule(homeA);
    const release = acquireWorkerLock();
    expect(JSON.parse(readFileSync(workerLockPath(), "utf8")).startedAt).not.toBe(
      "2020-01-01T00:00:00.000Z",
    );
    release();
  });

  it("a second `agent run` exits cleanly rather than failing", async () => {
    // End to end through the CLI: the second process must be a quiet no-op,
    // not a crash the tray's watchdog would then try to restart for ever.
    const { acquireWorkerLock } = await lockModule(homeA);
    const release = acquireWorkerLock();

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve(process.cwd(), "agent", "src", "cli.ts"), "run"],
      {
        env: { ...process.env, AGENT_DATA_DIR: homeA },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.status, `stderr: ${result.stderr?.slice(-400)}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/already running/i);
    release();
  }, 180_000);
});
