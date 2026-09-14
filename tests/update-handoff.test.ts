/**
 * The installer must not be waited for by the program it is replacing.
 *
 * What happened for real on 2026-09-14 (DEV, v1.1.9 → v1.1.10, SYSTEM task):
 * the updater is `runtime\node.exe agent.js auto-update`, it started the
 * installer and waited for it; the installer replaced SDCAgent.exe and
 * agent.js, then tried runtime\node.exe - "DeleteFile failed; code 5, in
 * use" - and put up an Abort/Retry/Ignore box that a SYSTEM session never
 * shows. Fifteen minutes later the updater's timeout killed it. The task
 * registration and the tray relaunch that follow a successful install never
 * ran.
 *
 * These tests stage a runtime\node.exe (a copy of this node), run the driver
 * from THAT copy, and let a stand-in installer - a second copy of node with
 * the fake preloaded, so it is a separate image the way Setup.exe is - do
 * exactly what Inno does to the file. Real processes, real file locks. The
 * old mechanism is kept as a characterisation: it must still fail, so the
 * fix is proven against the thing it fixes rather than against a mock.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FIXTURES = resolve(process.cwd(), "tests", "fixtures", "handoff");
const DRIVER = join(FIXTURES, "driver.mts");
const FAKE_INSTALLER = join(FIXTURES, "fake-installer.cjs");

let home: string;
let stagedNode: string;
let setupExe: string;
let replacement: string;
let marker: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-handoff-"));
  process.env.AGENT_DATA_DIR = join(home, "data");
  mkdirSync(join(home, "app", "runtime"), { recursive: true });
  mkdirSync(join(home, "data", "logs"), { recursive: true });
  // The runtime the updater runs from - the file the installer must replace.
  stagedNode = join(home, "app", "runtime", "node.exe");
  copyFileSync(process.execPath, stagedNode);
  // The "installer": a different image on disk, like Setup.exe is.
  setupExe = join(home, "SDCAgent-Setup-9.9.9.exe");
  copyFileSync(process.execPath, setupExe);
  // What the installer writes in place of runtime\node.exe. Different bytes
  // on purpose: identical bytes must not be allowed to hide a lock.
  replacement = join(home, "node-new.bin");
  writeFileSync(replacement, Buffer.concat([readFileSync(process.execPath).subarray(0, 4096), Buffer.from("NEW RUNTIME")]));
  marker = join(home, "installer.json");
});
afterEach(async () => {
  // The installer is detached and, under a loaded full-suite run, may still be
  // exiting when the test ends - it has just rewritten a node.exe in here.
  // Wait for the dir to become removable, but never let cleanup fail the test:
  // a leaked temp dir under the OS temp root is harmless, an EPERM thrown from
  // teardown is not.
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(home, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

const env = () => ({
  ...process.env,
  AGENT_DATA_DIR: join(home, "data"),
  HANDOFF_FAKE: FAKE_INSTALLER,
  HANDOFF_TARGET: stagedNode,
  HANDOFF_REPLACEMENT: replacement,
  HANDOFF_MARKER: marker,
});

interface DriverResult {
  mode: string;
  pid: number;
  exe: string;
  startedAt: number;
  exitingAt: number;
  installerExit?: number | string;
  handoff?: { pid: number; startedAt: string };
}
interface InstallerResult {
  outcome: "IN_USE" | "REPLACED";
  pid: number;
  ppid: number;
  startedAt: number;
  finishedAt: number;
  attempts: number;
}

/** Runs the driver from the STAGED node.exe and waits for that process to exit. */
function runDriver(mode: "wait" | "handoff"): Promise<{ code: number | null; exitedAt: number; result: DriverResult; stderr: string }> {
  const resultFile = join(home, `driver-${counter++}.json`);
  return new Promise((done, fail) => {
    let stderr = "";
    // tsx is resolved from the repo, which is the cwd.
    const child = spawn(stagedNode, ["--import", "tsx", DRIVER, mode, setupExe, resultFile], {
      cwd: process.cwd(),
      env: env(),
      windowsHide: true,
    });
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", fail);
    child.on("exit", (code) => {
      const exitedAt = Date.now();
      if (!existsSync(resultFile)) return fail(new Error(`driver wrote no result (exit ${code}): ${stderr.slice(-800)}`));
      done({ code, exitedAt, result: JSON.parse(readFileSync(resultFile, "utf8")) as DriverResult, stderr });
    });
  });
}

const waitFor = async (predicate: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!predicate() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return predicate();
};
const installerResult = () => JSON.parse(readFileSync(marker, "utf8")) as InstallerResult;
const isNewRuntime = () => readFileSync(stagedNode).includes("NEW RUNTIME");
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the lock that stopped the v1.1.10 self-update", () => {
  it("RED: an updater that waits for the installer keeps runtime\\node.exe locked, and the installer cannot replace it", async () => {
    const run = await runDriver("wait");
    expect(run.result.exe.toLowerCase()).toBe(stagedNode.toLowerCase()); // the driver really ran from the staged runtime
    const setup = installerResult();
    expect(setup.outcome).toBe("IN_USE"); // DeleteFile failed; code 5
    expect(setup.attempts).toBe(4);
    expect(run.result.installerExit).toBe(5);
    expect(isNewRuntime()).toBe(false); // the old runtime is still there
    expect(existsSync(stagedNode)).toBe(true);
  }, 60_000);
});

describe("the fixed hand-off", () => {
  it("GREEN: the updater starts the installer detached and exits; the installer then replaces runtime\\node.exe and finishes", async () => {
    const run = await runDriver("handoff");
    expect(run.code).toBe(0);
    expect(run.result.handoff?.pid).toBeGreaterThan(0);

    // The installer outlives the process that started it ...
    const finished = await waitFor(() => existsSync(marker), 20_000);
    expect(finished, "installer never finished after the updater exited").toBe(true);
    const setup = installerResult();
    expect(setup.pid).toBe(run.result.handoff!.pid);
    expect(setup.ppid).toBe(run.result.pid); // started by the updater ...
    expect(pidAlive(run.result.pid)).toBe(false); // ... which is gone

    // ... and could do what the real one could not.
    expect(setup.outcome).toBe("REPLACED");
    expect(isNewRuntime()).toBe(true);
    // The updater was out of the way well inside Inno's retry window, not
    // after a 15-minute timeout.
    expect(run.exitedAt - run.result.startedAt).toBeLessThan(15_000);
    expect(setup.finishedAt).toBeGreaterThanOrEqual(run.exitedAt - 50);
  }, 60_000);

  it("records the hand-off durably so a later run knows an installer is out there", async () => {
    const run = await runDriver("handoff");
    const store = await import(`../agent/src/update-command?h=${counter++}`);
    const evidence = store.loadInstallHandoff();
    expect(evidence).toMatchObject({ version: "9.9.9", pid: run.result.handoff!.pid, installerPath: setupExe });
    expect(evidence!.logPath).toContain(join("logs", "update-9.9.9.log"));
    // Let the detached installer finish replacing the staged runtime before
    // the fixture is torn down, so cleanup is not racing an open handle.
    await waitFor(() => existsSync(marker), 20_000);
  }, 60_000);
});
