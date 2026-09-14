/**
 * The installer must not begin until the updater is really gone.
 *
 * Real production, 2026-09-14 (05957 / DESKTOP-741A6BC): the updater is
 * `runtime\node.exe`, the installer must replace that file, and the updater
 * was still alive when the installer tried - DeleteFile code 5, an
 * Abort/Retry/Ignore box no SYSTEM session shows, a ~13-minute hang, then a
 * FAILED command even though a later manual install proved the installer
 * itself was fine. v1.1.10 waited for the installer synchronously; v1.1.11
 * spawned it detached and exited but never made it wait for the updater to
 * go, so the replacement could still race the lock.
 *
 * v1.1.12 puts a helper between the two: a small script run by a COPY of node
 * kept outside runtime\ (so it is never the file being replaced, and a
 * detached node child reliably outlives the updater). The helper is handed
 * the updater's pid, waits for it to exit, and only then starts the installer.
 * These tests stage a real runtime\node.exe, run the driver from it, and let
 * a real installer .exe (a compiled C# stub that does what Inno does to the
 * file) run - real processes, real locks. The racing model is kept as a red
 * characterisation; the fixed hand-off is the green one, and the ordering
 * updater-exit < installer-start is asserted from timestamps, not assumed.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const FIXTURES = resolve(process.cwd(), "tests", "fixtures", "handoff");
const DRIVER = join(FIXTURES, "driver.mts");
const HELPER_SRC = resolve(process.cwd(), "agent", "installer", "run-installer.mjs");

// A real installer .exe: it records when it started, then does what Inno does
// to an in-use file - tries to delete the target, retrying a few times, and
// gives up with code 5 if it cannot; on success it copies the replacement in
// and writes REPLACED. Behaviour is driven by environment, like the real one
// reads its own state, so the helper launches it with the fixed setup args.
const STUB_SOURCE = [
  "using System; using System.IO; using System.Threading;",
  "class Stub { static int Main() {",
  "  string target = Environment.GetEnvironmentVariable(\"HANDOFF_TARGET\");",
  "  string repl = Environment.GetEnvironmentVariable(\"HANDOFF_REPLACEMENT\");",
  "  string marker = Environment.GetEnvironmentVariable(\"HANDOFF_MARKER\");",
  "  string startFile = Environment.GetEnvironmentVariable(\"HANDOFF_START\");",
  "  File.WriteAllText(startFile, DateTime.UtcNow.ToString(\"o\"));",
  "  int n = 0; bool replaced = false;",
  "  while (n < 4) { n++; try { File.Delete(target); replaced = true; break; } catch { Thread.Sleep(250); } }",
  "  if (!replaced) { File.WriteAllText(marker, \"IN_USE \" + n); return 5; }",
  "  File.Copy(repl, target, true);",
  "  File.WriteAllText(marker, \"REPLACED \" + n);",
  "  return 0;",
  "} }",
].join("\n");

let stub: Buffer | null = null;
let home: string;
let stagedNode: string;
let setupExe: string;
let replacement: string;
let marker: string;
let startFile: string;
let counter = 0;

beforeAll(() => {
  const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  if (process.platform !== "win32" || !existsSync(csc)) return;
  const dir = mkdtempSync(resolve(tmpdir(), "sdc-stub-"));
  const src = join(dir, "stub.cs");
  const exe = join(dir, "stub.exe");
  writeFileSync(src, STUB_SOURCE, "utf8");
  const built = spawnSync(csc, ["/nologo", "/target:exe", `/out:${exe}`, src], { encoding: "utf8" });
  if (built.status === 0 && existsSync(exe)) stub = readFileSync(exe);
});

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-handoff-"));
  process.env.AGENT_DATA_DIR = join(home, "data");
  mkdirSync(join(home, "app", "runtime"), { recursive: true });
  mkdirSync(join(home, "data", "logs"), { recursive: true });
  // The runtime the updater runs from - the file the installer must replace.
  stagedNode = join(home, "app", "runtime", "node.exe");
  copyFileSync(process.execPath, stagedNode);
  // The helper the updater launches, shipped beside the program (app root).
  copyFileSync(HELPER_SRC, join(home, "app", "run-installer.mjs"));
  // The "installer": a real, separate .exe, named like the published one.
  setupExe = join(home, "SDCAgent-Setup-9.9.9.exe");
  if (stub) writeFileSync(setupExe, stub);
  // What the installer writes in place of runtime\node.exe. Different bytes on
  // purpose: identical bytes must not be allowed to hide a lock.
  replacement = join(home, "node-new.bin");
  writeFileSync(replacement, Buffer.concat([readFileSync(process.execPath).subarray(0, 4096), Buffer.from("NEW RUNTIME")]));
  marker = join(home, "installer.marker");
  startFile = join(home, "installer.start");
});
afterEach(async () => {
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(home, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});
afterAll(() => {});

const env = () => ({
  ...process.env,
  AGENT_DATA_DIR: join(home, "data"),
  HANDOFF_TARGET: stagedNode,
  HANDOFF_REPLACEMENT: replacement,
  HANDOFF_MARKER: marker,
  HANDOFF_START: startFile,
});

interface DriverResult {
  mode: string;
  pid: number;
  exe: string;
  startedAt: number;
  exitingAt: number;
  raced?: boolean;
  handoff?: { helperPid: number; updaterPid: number; resultPath: string; version: string };
}

/** Runs the driver from the STAGED node.exe and resolves when that process has exited. */
function runDriver(mode: "race" | "handoff"): Promise<{ code: number | null; exitedAt: number; result: DriverResult; stderr: string }> {
  const resultFile = join(home, `driver-${counter++}.json`);
  return new Promise((done, fail) => {
    let stderr = "";
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
const markerOutcome = () => readFileSync(marker, "utf8").trim().split(/\s+/)[0];
const isNewRuntime = () => readFileSync(stagedNode).includes("NEW RUNTIME");

describe("the lock that stopped the real canary", () => {
  it("RED: an installer started before the updater exits cannot replace runtime\\node.exe", async () => {
    if (!stub) return;
    const run = await runDriver("race");
    expect(run.result.raced).toBe(true);
    // The installer ran while the driver still held the staged node.exe, so it
    // did what Inno did on 05957: retried the delete and gave up.
    const finished = await waitFor(() => existsSync(marker), 20_000);
    expect(finished).toBe(true);
    expect(markerOutcome()).toBe("IN_USE");
    expect(isNewRuntime()).toBe(false);
  }, 60_000);
});

describe("the v1.1.12 helper hand-off", () => {
  it("GREEN: the helper waits for the updater to exit, then the installer replaces node.exe", async () => {
    if (!stub) return;
    const run = await runDriver("handoff");
    expect(run.code).toBe(0);
    expect(run.result.handoff?.helperPid).toBeGreaterThan(0);
    expect(run.result.handoff?.updaterPid).toBe(run.result.pid);

    // The installer runs only after the updater is gone, so it succeeds where
    // the racing model failed.
    const finished = await waitFor(() => existsSync(marker), 40_000);
    expect(finished, "installer never finished").toBe(true);
    expect(markerOutcome()).toBe("REPLACED");
    expect(isNewRuntime()).toBe(true);

    // The ordering that is the whole point: the installer did not START until
    // after the updater process had EXITED. Proven from the clock, not assumed.
    expect(existsSync(startFile)).toBe(true);
    const installerStartedAt = new Date(readFileSync(startFile, "utf8").trim()).getTime();
    expect(installerStartedAt).toBeGreaterThanOrEqual(run.exitedAt - 500);
  }, 90_000);

  it("records the hand-off durably, naming the helper and the updater it waits for", async () => {
    if (!stub) return;
    const run = await runDriver("handoff");
    const store = await import(`../agent/src/update-command?h=${counter++}`);
    const evidence = store.loadInstallHandoff();
    expect(evidence).toMatchObject({ version: "9.9.9", helperPid: run.result.handoff!.helperPid, updaterPid: run.result.pid });
    expect(evidence!.resultPath).toContain("handoff-9.9.9");
    await waitFor(() => existsSync(marker), 40_000);
  }, 90_000);

  it("does not start the installer at all when the updater never exits", async () => {
    if (!stub) return;
    // A process that never exits stands in for an updater that will not let go.
    // The helper is run directly (from the staged node - fine, it is not the
    // target here) with a short wait so the test does not sit for two minutes.
    const holder = spawn(stagedNode, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true });
    await new Promise((r) => setTimeout(r, 500));
    const resultPath = join(home, "result-alive.json");
    const helper = join(home, "app", "run-installer.mjs");
    try {
      await new Promise<void>((done, fail) => {
        const h = spawn(
          stagedNode,
          [helper, "--updater-pid", String(holder.pid), "--updater-image", "node.exe",
            "--installer", setupExe, "--installer-log", join(home, "x.log"),
            "--result", resultPath, "--wait-ms", "3000", "--grace-ms", "0"],
          { env: env(), windowsHide: true },
        );
        h.on("error", fail);
        h.on("exit", () => done());
      });
      expect(existsSync(resultPath)).toBe(true);
      expect(JSON.parse(readFileSync(resultPath, "utf8")).outcome).toBe("UPDATER_ALIVE");
      // The installer was never started, so it left neither mark.
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(startFile)).toBe(false);
    } finally {
      holder.kill();
    }
  }, 60_000);
});
