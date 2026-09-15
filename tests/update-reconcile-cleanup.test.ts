/**
 * Post-install reconciliation must survive a cleanup that cannot delete.
 *
 * Production incident, 2026-09-14 (05957 / DESKTOP-741A6BC): the command
 * update installed cleanly - the v1.1.14 build started and its log said
 * "อัปเดตสำเร็จ (ยืนยันหลังเริ่มโปรแกรมใหม่)" - but the very next thing the
 * user-session worker (DrugOPD) did was try to delete the hand-off result
 * file the SYSTEM helper had written under the administrators/SYSTEM-only
 * updates directory. That rm threw EPERM, the exception escaped
 * reconcileUpdateCommandAfterRestart(), the worker crashed, the watchdog
 * restarted it, and it crashed the same way - so the command was never
 * durably moved to SUCCESS even though the machine was already on the target.
 *
 * The rule these tests pin down: reaching the target version is authoritative
 * SUCCESS, persisted BEFORE any hand-off cleanup, and cleanup that cannot
 * read/delete a protected artifact is best-effort and must never crash the
 * worker. A directory standing in for the undeletable result file makes the
 * cleanup rm throw for real (EPERM on Windows, EISDIR elsewhere) - the point
 * is only that cleanup throws, which is exactly what escaped before.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-reconcile-"));
  process.env.AGENT_DATA_DIR = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const store = () => import(`../agent/src/update-command?r=${counter++}`);
const config = () => import(`../agent/src/config?r=${counter++}`);

type Store = Awaited<ReturnType<typeof store>>;

function seedCommand(s: Store, over: Partial<Parameters<typeof s.saveUpdateCommand>[0]> = {}) {
  const now = new Date().toISOString();
  s.saveUpdateCommand({
    commandId: "cmd-eperm",
    targetVersion: "1.0.0", // <= AGENT_VERSION, so "target reached"
    assetName: "SDCAgent-Setup-1.0.0.exe",
    size: 10,
    sha256: "a".repeat(64),
    state: "INSTALLING",
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    errorAt: null,
    receivedAt: now,
    updatedAt: now,
    succeededAt: null,
    ...over,
  });
}

/** A hand-off whose result path is a directory, so cleanup's rm throws like an undeletable SYSTEM file. */
function seedUndeletableHandoff(s: Store) {
  const resultDir = join(home, "updates", "handoff-1.0.0.result.json");
  mkdirSync(resultDir, { recursive: true });
  s.saveInstallHandoff({
    version: "1.0.0",
    installerPath: join(home, "updates", "1.0.0", "SDCAgent-Setup-1.0.0.exe"),
    helperPid: 424242,
    updaterPid: 424243,
    resultPath: resultDir,
    startedAt: new Date().toISOString(),
    logPath: join(home, "logs", "update-1.0.0.log"),
  });
}

describe("A. target reached but hand-off cleanup throws", () => {
  it("persists SUCCESS and does not throw", async () => {
    const s = await store();
    await config(); // AGENT_VERSION is the real current version, comfortably > 1.0.0
    seedCommand(s);
    seedUndeletableHandoff(s);

    const result = s.reconcileUpdateCommandAfterRestart();

    expect(result?.state).toBe("SUCCESS");
    expect(result?.succeededAt).toBeTruthy();
    expect(result?.errorCode).toBeNull();
    expect(result?.errorMessage).toBeNull();
    // And it is durable - what a restarted worker would read is SUCCESS.
    expect(s.loadUpdateCommand()?.state).toBe("SUCCESS");
  });
});

describe("B. cleanup failure cannot undo an already-successful reconciliation", () => {
  it("SUCCESS survives, and a second reconcile is idempotent (no retry, no re-install)", async () => {
    const s = await store();
    seedCommand(s);
    seedUndeletableHandoff(s);

    const first = s.reconcileUpdateCommandAfterRestart();
    expect(first?.state).toBe("SUCCESS");
    const succeededAt = first?.succeededAt;

    // Another worker start: terminal SUCCESS is returned unchanged.
    const second = s.reconcileUpdateCommandAfterRestart();
    expect(second?.state).toBe("SUCCESS");
    expect(second?.succeededAt).toBe(succeededAt);
    expect(second?.attempts).toBe(1); // no new install attempt
  });
});

describe("C. cleanup throw on the not-reached path is non-fatal and keeps the retry policy", () => {
  it("below target with an undeletable result: retries rather than crashing or falsely succeeding", async () => {
    const s = await store();
    // Target above the running version: NOT reached. Helper is not running
    // (helperPid dead) so the hand-off is considered finished.
    seedCommand(s, { targetVersion: "9.9.9", attempts: 1 });
    const resultDir = join(home, "updates", "handoff-9.9.9.result.json");
    mkdirSync(resultDir, { recursive: true });
    s.saveInstallHandoff({
      version: "9.9.9",
      installerPath: join(home, "x.exe"),
      helperPid: 424242,
      updaterPid: 424243,
      resultPath: resultDir,
      startedAt: new Date().toISOString(),
      logPath: join(home, "logs", "update-9.9.9.log"),
    });

    const result = s.reconcileUpdateCommandAfterRestart();
    // Not crashed, not falsely SUCCESS: another attempt is scheduled.
    expect(result?.state).toBe("DELIVERED");
    expect(s.loadUpdateCommand()?.state).toBe("DELIVERED");
  });

  it("below target, attempts exhausted, undeletable result: FAILED, never SUCCESS, never a crash", async () => {
    const s = await store();
    const { MAX_UPDATE_ATTEMPTS } = await import("@/lib/shared/update-command");
    seedCommand(s, { targetVersion: "9.9.9", attempts: MAX_UPDATE_ATTEMPTS });
    const resultDir = join(home, "updates", "handoff-9.9.9.result.json");
    mkdirSync(resultDir, { recursive: true });
    s.saveInstallHandoff({
      version: "9.9.9",
      installerPath: join(home, "x.exe"),
      helperPid: 424242,
      updaterPid: 424243,
      resultPath: resultDir,
      startedAt: new Date().toISOString(),
      logPath: join(home, "logs", "update-9.9.9.log"),
    });

    const result = s.reconcileUpdateCommandAfterRestart();
    expect(result?.state).toBe("FAILED");
    expect(result?.errorCode).toBe("INSTALL_INCOMPLETE");
  });
});

describe("D. clearInstallHandoff is best-effort", () => {
  it("never throws when the result cannot be deleted", async () => {
    const s = await store();
    seedUndeletableHandoff(s);
    expect(() => s.clearInstallHandoff()).not.toThrow();
  });
});
