/**
 * The Agent's side of a remote update: one engine, whichever way it starts.
 *
 * A held command from the centre and the ordinary half-hourly check both run
 * the same code, so these tests drive that code with the installer, the
 * download and the busy check injected - and then, for the parts that must be
 * proven on a real process, run `agent auto-update` itself against a counting
 * Central with a command file already on disk.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(process.cwd(), "agent", "src", "cli.ts");
let home: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-engine-"));
  process.env.AGENT_DATA_DIR = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fresh = async () => ({
  engine: await import(`../agent/src/updater?e=${counter++}`),
  store: await import(`../agent/src/update-command?e=${counter}`),
  config: await import(`../agent/src/config?e=${counter}`),
});

const TARGET = "9.9.9";
const SHA = "b".repeat(64);
const manifestFor = (version: string, sha = SHA) => ({
  available: true,
  version,
  assetName: `SDCAgent-Setup-${version}.exe`,
  size: 10,
  sha256: sha,
  autoInstall: true,
});

function hold(store: Awaited<ReturnType<typeof fresh>>["store"], targetVersion = TARGET, sha = SHA) {
  store.acceptUpdateCommand({ id: "cmd-1", targetVersion, assetName: `SDCAgent-Setup-${targetVersion}.exe`, size: 10, sha256: sha });
  return store.loadUpdateCommand()!;
}

describe("E. an active sync", () => {
  it("makes the command wait; no download and no installer while a run is in flight", async () => {
    const { engine, store } = await fresh();
    const command = hold(store);
    let downloads = 0;
    let installs = 0;
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "command",
      command,
      fetchManifestFn: async () => manifestFor(TARGET),
      downloadFn: async () => { downloads++; return join(home, "x.exe"); },
      installFn: async () => { installs++; },
      busyFn: () => true,
    });
    expect(result.state).toBe("WAITING_FOR_IDLE");
    expect(downloads).toBe(0);
    expect(installs).toBe(0);
    expect(store.loadUpdateCommand()?.state).toBe("WAITING_FOR_IDLE");
  });

  it("proceeds once idle, through DOWNLOADING, VERIFYING and INSTALLING", async () => {
    const { engine, store } = await fresh();
    const command = hold(store);
    const seen: string[] = [];
    const installer = join(home, "SDCAgent-Setup-9.9.9.exe");
    writeFileSync(installer, "0123456789");
    const sha = createHash("sha256").update("0123456789").digest("hex");
    store.saveUpdateCommand({ ...command, sha256: sha });
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "command",
      command: store.loadUpdateCommand()!,
      fetchManifestFn: async () => manifestFor(TARGET, sha),
      downloadFn: async () => { seen.push(store.loadUpdateCommand()!.state); return installer; },
      installFn: async () => { seen.push(store.loadUpdateCommand()!.state); },
      busyFn: () => false,
    });
    expect(seen).toEqual(["DOWNLOADING", "INSTALLING"]);
    expect(result.state).toBe("INSTALLING");
    expect(result.installed).toBe(true);
    // SUCCESS is deliberately not written by the process the installer is
    // about to replace; the new build's first start writes it.
    expect(store.loadUpdateCommand()?.state).toBe("INSTALLING");
    expect(store.loadUpdateCommand()?.attempts).toBe(1);
  });

  it("re-checks idle right before the installer, after a slow download", async () => {
    const { engine, store } = await fresh();
    const command = hold(store);
    const installer = join(home, "SDCAgent-Setup-9.9.9.exe");
    writeFileSync(installer, "0123456789");
    const sha = createHash("sha256").update("0123456789").digest("hex");
    store.saveUpdateCommand({ ...command, sha256: sha });
    let calls = 0;
    let installs = 0;
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "command",
      command: store.loadUpdateCommand()!,
      fetchManifestFn: async () => manifestFor(TARGET, sha),
      downloadFn: async () => installer,
      installFn: async () => { installs++; },
      busyFn: () => calls++ > 0, // idle at first, busy by the time the download is done
    });
    expect(result.state).toBe("WAITING_FOR_IDLE");
    expect(installs).toBe(0);
  });
});

describe("F. what may never be installed", () => {
  it("a file whose SHA-256 is wrong: failed, deleted, not retried", async () => {
    const { engine, store } = await fresh();
    const command = hold(store);
    let installs = 0;
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "command",
      command,
      fetchManifestFn: async () => manifestFor(TARGET),
      downloadFn: async () => { throw new Error("ค่าตรวจสอบไฟล์ (SHA-256) ไม่ตรงกับที่ประกาศไว้ ยกเลิกการติดตั้ง"); },
      installFn: async () => { installs++; },
      busyFn: () => false,
    });
    expect(result.state).toBe("FAILED");
    expect(result.errorCode).toBe("DIGEST_MISMATCH");
    expect(installs).toBe(0);
    expect(store.loadUpdateCommand()?.state).toBe("FAILED");
    expect(store.loadUpdateCommand()?.errorCode).toBe("DIGEST_MISMATCH");
  });

  it("a release with no digest: blocked, never installed unattended", async () => {
    const { engine, store } = await fresh();
    const command = hold(store);
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "command",
      command,
      fetchManifestFn: async () => ({ ...manifestFor(TARGET), sha256: null, autoInstall: false }),
      downloadFn: async () => { throw new Error("must not be called"); },
      installFn: async () => { throw new Error("must not be called"); },
      busyFn: () => false,
    });
    expect(result.state).toBe("BLOCKED");
    expect(store.loadUpdateCommand()?.state).toBe("FAILED");
    expect(store.loadUpdateCommand()?.errorCode).toBe("DIGEST_MISSING");
  });

  it("never a downgrade or a reinstall: a command for an older or equal version closes as done", async () => {
    const { engine, store, config } = await fresh();
    // The centre would never send this, but the Agent must not trust that.
    const accepted = store.acceptUpdateCommand({ id: "cmd-old", targetVersion: "1.0.0", assetName: "SDCAgent-Setup-1.0.0.exe", size: 1, sha256: SHA });
    expect(accepted.accepted).toBe(true);
    expect(store.loadUpdateCommand()?.state).toBe("SUCCESS"); // nothing to do, and it says so
    // And through the engine, a manifest that is not newer is NONE.
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "scheduled",
      command: null,
      fetchManifestFn: async () => manifestFor(config.AGENT_VERSION),
      downloadFn: async () => { throw new Error("must not be called"); },
      installFn: async () => { throw new Error("must not be called"); },
      busyFn: () => false,
    });
    expect(result.state).toBe("NONE");
  });

  it("a command pinned to a release the centre no longer publishes fails as TARGET_NOT_AVAILABLE", async () => {
    const { engine, store } = await fresh();
    const command = hold(store, "9.9.9");
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "command",
      command,
      fetchManifestFn: async () => manifestFor("9.9.10"),
      downloadFn: async () => { throw new Error("must not be called"); },
      installFn: async () => { throw new Error("must not be called"); },
      busyFn: () => false,
    });
    expect(result.state).toBe("FAILED");
    expect(result.errorCode).toBe("TARGET_NOT_AVAILABLE");
  });

  it("a wrong asset name is refused before anything is fetched", async () => {
    const { engine } = await fresh();
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "scheduled",
      command: null,
      fetchManifestFn: async () => ({ ...manifestFor(TARGET), assetName: "evil.exe" }),
      downloadFn: async () => { throw new Error("must not be called"); },
      installFn: async () => { throw new Error("must not be called"); },
      busyFn: () => false,
    });
    expect(result.state).toBe("BLOCKED");
  });
});

describe("retry policy", () => {
  it("a network failure keeps the command for another try, up to the limit", async () => {
    const { engine, store } = await fresh();
    let command = hold(store);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await engine.runUpdateEngine({
        baseUrl: "http://central.invalid/",
        trigger: "command",
        command,
        fetchManifestFn: async () => manifestFor(TARGET),
        downloadFn: async () => { throw new Error("ดาวน์โหลดไม่สำเร็จ (503)"); },
        installFn: async () => { throw new Error("must not be called"); },
        busyFn: () => false,
      });
      expect(result.errorCode).toBe("DOWNLOAD_FAILED");
      command = store.loadUpdateCommand()!;
      if (attempt < 3) expect(command.state, `attempt ${attempt}`).toBe("DELIVERED");
    }
    expect(command.state).toBe("FAILED");
    expect(command.attempts).toBe(3);
  });

  it("an unreachable centre leaves the command open and untouched", async () => {
    const { engine, store } = await fresh();
    const command = hold(store);
    const result = await engine.runUpdateEngine({
      baseUrl: "http://central.invalid/",
      trigger: "command",
      command,
      fetchManifestFn: async () => { throw new Error("fetch failed"); },
      downloadFn: async () => { throw new Error("must not be called"); },
      installFn: async () => { throw new Error("must not be called"); },
      busyFn: () => false,
    });
    expect(result.errorCode).toBe("CENTRAL_UNAVAILABLE");
    expect(store.loadUpdateCommand()?.state).toBe("DELIVERED");
    expect(store.loadUpdateCommand()?.attempts).toBe(0);
  });
});

describe("G. a restart in the middle", () => {
  it("INSTALLING plus a build at the target is SUCCESS", async () => {
    const { store, config } = await fresh();
    store.saveUpdateCommand({
      commandId: "cmd-r", targetVersion: config.AGENT_VERSION, assetName: "x.exe", size: 1, sha256: SHA,
      state: "INSTALLING", attempts: 1, errorCode: null, errorMessage: null, errorAt: null,
      receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), succeededAt: null,
    });
    const after = store.reconcileUpdateCommandAfterRestart();
    expect(after?.state).toBe("SUCCESS");
    expect(after?.succeededAt).toBeTruthy();
    // Idempotent: a second start changes nothing.
    expect(store.reconcileUpdateCommandAfterRestart()?.state).toBe("SUCCESS");
  });

  it("INSTALLING but still the old build, with attempts left, goes back to DELIVERED for another go", async () => {
    const { store } = await fresh();
    store.saveUpdateCommand({
      commandId: "cmd-r", targetVersion: "9.9.9", assetName: "x.exe", size: 1, sha256: SHA,
      state: "INSTALLING", attempts: 1, errorCode: null, errorMessage: null, errorAt: null,
      receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), succeededAt: null,
    });
    expect(store.reconcileUpdateCommandAfterRestart()?.state).toBe("DELIVERED");
  });

  it("INSTALLING with attempts exhausted is FAILED, so a person is told", async () => {
    const { store } = await fresh();
    store.saveUpdateCommand({
      commandId: "cmd-r", targetVersion: "9.9.9", assetName: "x.exe", size: 1, sha256: SHA,
      state: "INSTALLING", attempts: 3, errorCode: null, errorMessage: null, errorAt: null,
      receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), succeededAt: null,
    });
    const after = store.reconcileUpdateCommandAfterRestart();
    expect(after?.state).toBe("FAILED");
    expect(after?.errorCode).toBe("INSTALL_INCOMPLETE");
  });

  it("a terminal SUCCESS is never lost by a later restart or a repeated delivery", async () => {
    const { store, config } = await fresh();
    store.saveUpdateCommand({
      commandId: "cmd-r", targetVersion: config.AGENT_VERSION, assetName: "x.exe", size: 1, sha256: SHA,
      state: "SUCCESS", attempts: 1, errorCode: null, errorMessage: null, errorAt: null,
      receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), succeededAt: new Date().toISOString(),
    });
    store.reconcileUpdateCommandAfterRestart();
    // The centre repeats the command (it has not heard SUCCESS yet); same id, no change.
    const again = store.acceptUpdateCommand({ id: "cmd-r", targetVersion: config.AGENT_VERSION, assetName: "x.exe", size: 1, sha256: SHA });
    expect(again.accepted).toBe(false);
    expect(store.loadUpdateCommand()?.state).toBe("SUCCESS");
    // The report carries it.
    const report = store.buildUpdateReport();
    expect(report.commandId).toBe("cmd-r");
    expect(report.state).toBe("SUCCESS");
    expect(report.succeededAt).toBeTruthy();
  });

  it("a second command cannot replace one still in flight", async () => {
    const { store } = await fresh();
    hold(store);
    store.advanceUpdateCommand("DOWNLOADING", { attempt: true });
    const other = store.acceptUpdateCommand({ id: "cmd-2", targetVersion: "9.9.10", assetName: "x.exe", size: 1, sha256: SHA });
    expect(other.accepted).toBe(false);
    expect(store.loadUpdateCommand()?.commandId).toBe("cmd-1");
  });
});

describe("I. the task, as the Agent judges it", () => {
  it("knows exactly what a v1.1.8-style task lacks", async () => {
    const { engine } = await fresh();
    const base = { present: true, cadence: "PT30M", runAs: "S-1-5-18", lastRun: null, lastResult: "0", startWhenAvailable: true, allowOnBatteries: true, slot: "00:20", checkedAt: "" };
    expect(engine.updaterTaskNeedsRepair(base)).toBeNull();
    expect(engine.updaterTaskNeedsRepair({ ...base, present: false })).toMatch(/missing/);
    expect(engine.updaterTaskNeedsRepair({ ...base, cadence: "PT4H" })).toMatch(/cadence/);
    expect(engine.updaterTaskNeedsRepair({ ...base, runAs: "DESKTOP\\user" })).toMatch(/run-as/);
    expect(engine.updaterTaskNeedsRepair({ ...base, startWhenAvailable: false })).toMatch(/missed/);
    expect(engine.updaterTaskNeedsRepair({ ...base, allowOnBatteries: false })).toMatch(/battery/);
  });

  it("does not repair anything unless it is SYSTEM, and never a task that is not its own", async () => {
    const { engine } = await fresh();
    // This test process is not SYSTEM.
    const result = await engine.repairUpdaterTask({
      appDir: "C:\\Program Files\\SDC Agent",
      identity: "x",
      health: { present: true, cadence: "PT4H", runAs: "S-1-5-18", lastRun: null, lastResult: null, startWhenAvailable: false, allowOnBatteries: false, slot: null, checkedAt: "" },
    });
    expect(result.repaired).toBe(false);
    expect(result.reason).toMatch(/not SYSTEM/);
  });
});

/* ------------------------------------------- the real process, end to end */

describe("the real `agent auto-update` with a held command", () => {
  let central: Server;
  let hits: string[];

  beforeEach(async () => {
    hits = [];
    const installerBytes = Buffer.from("not a real installer, but its bytes are what the digest covers");
    const sha = createHash("sha256").update(installerBytes).digest("hex");
    central = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url?.startsWith("/api/agent/update")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ available: true, version: "9.9.9", assetName: "SDCAgent-Setup-9.9.9.exe", size: installerBytes.length, sha256: sha, autoInstall: true }));
        return;
      }
      if (req.url?.startsWith("/download/agent")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(installerBytes);
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((d) => central.listen(0, "127.0.0.1", d));
    const port = (central.address() as { port: number }).port;
    writeFileSync(join(home, "agent.config.json"), JSON.stringify({
      agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: `http://127.0.0.1:${port}/`,
      facilityId: "f", facilityCode: "T", expectedPcucode: "T0001", installationId: "i", syncIntervalMinutes: 60, reprocessDays: 7,
    }));
    writeFileSync(join(home, "jhcis.json"), JSON.stringify({ host: "127.0.0.1", port: 1, database: "none", user: "root", password: "" }));
    mkdirSync(join(home, "updates"), { recursive: true });
    writeFileSync(join(home, "update-command.json"), JSON.stringify({
      commandId: "cmd-real", targetVersion: "9.9.9", assetName: "SDCAgent-Setup-9.9.9.exe", size: installerBytes.length, sha256: sha,
      state: "DELIVERED", attempts: 0, errorCode: null, errorMessage: null, errorAt: null,
      receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), succeededAt: null,
    }));
  });
  afterEach(async () => {
    await new Promise<void>((d) => central.close(() => d()));
  });

  const run = () =>
    new Promise<{ status: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, ["--import", "tsx", CLI, "auto-update"], { env: { ...process.env, AGENT_DATA_DIR: home } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const t = setTimeout(() => child.kill(), 120_000);
      child.on("close", (status) => { clearTimeout(t); done({ status, out }); });
    });

  it("checks, downloads, verifies the digest, tries the installer, and records the outcome durably", async () => {
    const { status } = await run();
    // The 'installer' is not executable, so the run ends at INSTALLER_FAILED -
    // which is the last step a test can reach without installing software on
    // this machine, and it proves every step before it ran on the real process.
    expect(status).toBe(1);
    expect(hits).toEqual(["GET /api/agent/update", "GET /download/agent"]);
    const command = JSON.parse(readFileSync(join(home, "update-command.json"), "utf8"));
    expect(command.commandId).toBe("cmd-real");
    expect(command.state).toBe("FAILED");
    expect(command.errorCode).toBe("INSTALLER_FAILED");
    expect(command.attempts).toBe(1);
    // The verified file exists where only SYSTEM may write on a real install.
    expect(existsSync(join(home, "updates", "9.9.9", "SDCAgent-Setup-9.9.9.exe"))).toBe(true);
    // No JHCIS read happened (port 1 would have refused loudly), no batch, no watermark.
    expect(existsSync(join(home, "state.json"))).toBe(false);
    const status2 = JSON.parse(readFileSync(join(home, "status.json"), "utf8"));
    expect(status2.autoUpdateTaskLastResult).toMatch(/^FAILED version=9\.9\.9 INSTALLER_FAILED .* command=cmd-real/);
  }, 180_000);

  it("a paused clinic still runs the whole path", async () => {
    writeFileSync(join(home, "state.json"), JSON.stringify({ lastSyncedVisitDate: "2026-09-10", lastSyncAt: null, batchSequence: 3, syncControlState: "PAUSED", appliedControlRevision: 2, pauseReason: "รีเซ็ต" }));
    await run();
    expect(hits[0]).toBe("GET /api/agent/update");
    expect(hits[1]).toBe("GET /download/agent");
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    expect(state.syncControlState).toBe("PAUSED");
    expect(state.batchSequence).toBe(3);
  }, 180_000);
});
