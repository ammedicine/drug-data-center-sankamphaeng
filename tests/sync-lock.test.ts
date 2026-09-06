/**
 * One sync pipeline per machine.
 *
 * The tray runs `sdc-agent sync` in its own process while the background
 * worker may be mid-run; both write batchSequence, state.json, status.json and
 * the queue. The lock has to stop that - and, just as importantly, must never
 * leave a clinic PC unable to sync after a crash or a power cut.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(resolve(tmpdir(), "sdc-lock-"));
  process.env.AGENT_DATA_DIR = workDir;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

async function lockModule() {
  return import(`../agent/src/lock?${Date.now()}`);
}

describe("cross-process sync lock", () => {
  it("refuses a second pipeline while one is running", async () => {
    const { withSyncLock, SyncLockedError } = await lockModule();
    let inner: unknown = null;

    await withSyncLock("worker", async () => {
      try {
        await withSyncLock("tray", async () => {
          throw new Error("should never run");
        });
      } catch (error) {
        inner = error;
      }
    });

    expect(inner).toBeInstanceOf(SyncLockedError);
  });

  it("releases the lock when the work finishes", async () => {
    const { withSyncLock, lockPath } = await lockModule();
    await withSyncLock("first", async () => {});
    let ran = false;
    await withSyncLock("second", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(() => readFileSync(lockPath(), "utf8")).toThrow();
  });

  it("releases the lock when the work throws", async () => {
    const { withSyncLock } = await lockModule();
    await expect(
      withSyncLock("failing", async () => {
        throw new Error("sync blew up");
      }),
    ).rejects.toThrow("sync blew up");

    let ran = false;
    await withSyncLock("after", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("takes over a lock whose owner no longer exists", async () => {
    const { withSyncLock, lockPath } = await lockModule();
    // What a power cut leaves behind: a lock file for a pid that is gone.
    writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: 0x7ffffff,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        label: "เครื่องดับกลางคัน",
      }),
      "utf8",
    );

    let ran = false;
    await withSyncLock("recovering", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("takes over a lock that stopped being refreshed", async () => {
    const { withSyncLock, lockPath } = await lockModule();
    // A live pid - this test process - but an ancient heartbeat, which is what
    // a hung or suspended process looks like from outside.
    writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
        label: "ค้าง",
      }),
      "utf8",
    );

    let ran = false;
    await withSyncLock("recovering", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("does not block a different machine's agent", async () => {
    const { withSyncLock, lockPath } = await lockModule();
    // Two รพ.สต. must sync at the same time; a pid from another host means
    // nothing here even if it happens to exist locally.
    writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: process.pid,
        hostname: "another-clinic-pc",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        label: "อีกเครื่อง",
      }),
      "utf8",
    );

    let ran = false;
    await withSyncLock("local", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
