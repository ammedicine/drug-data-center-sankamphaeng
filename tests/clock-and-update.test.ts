/**
 * A wrong clock, and updating fifteen clinics without visiting them.
 *
 * Both halves exist because of the same afternoon. A รพ.สต. PC whose Windows
 * clock had drifted 41 minutes could not sign a request the centre would
 * accept, and the window told whoever was looking at it that the Agent's
 * credential had been cancelled and to contact the administrator. Nothing was
 * wrong with the credential. The machine needed its clock set, and somebody
 * had to drive there to find that out.
 *
 * So: say which of those two things happened, fix the one that can be fixed,
 * and - since the fix ships as a new installer - make new installers reach the
 * clinics on their own. That last part runs elevated, which is why so much of
 * this file is about refusing to run the wrong file.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  classifyCentralFailure,
  clockStateFor,
  CLOCK_HEALTHY_SECONDS,
  CLOCK_SKEW_LIMIT_SECONDS,
} from "@/lib/shared/agent-status";
import { compareVersions, isNewerVersion, parseVersion } from "@/lib/shared/version";

let workDir: string;
let server: Server;
let baseUrl = "";

/** What the fake centre is pretending right now. */
const central = {
  offsetMs: 0,
  manifest: {} as Record<string, unknown>,
  asset: Buffer.alloc(0),
  downloads: 0,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/time") {
      const now = Date.now() + central.offsetMs;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ serverTime: new Date(now).toISOString(), serverUnixMs: now }));
      return;
    }
    if (path === "/api/agent/update") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(central.manifest));
      return;
    }
    if (path === "/download/agent") {
      central.downloads += 1;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(central.asset);
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => server?.close());

beforeEach(() => {
  workDir = mkdtempSync(resolve(tmpdir(), "sdc-clock-"));
  process.env.AGENT_DATA_DIR = workDir;
  central.offsetMs = 0;
  central.downloads = 0;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

let counter = 0;
const clockModule = () => import(`../agent/src/clock?c=${counter++}`);
const updaterModule = () => import(`../agent/src/updater?u=${counter++}`);
const configModule = () => import(`../agent/src/config?k=${counter++}`);

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * Runs the CLI as a real process.
 *
 * Asynchronously, and that matters: spawnSync would block this process's event
 * loop, and the fake Central above lives in this process - it could never
 * answer, so every such test would sit there until it timed out.
 */
function runCli(args: string[], home: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(process.cwd(), "agent", "src", "cli.ts"), ...args],
      { env: { ...process.env, AGENT_DATA_DIR: home }, encoding: "utf8" } as never,
    );
    let out = "";
    child.stdout?.on("data", (c) => (out += c));
    child.stderr?.on("data", (c) => (out += c));
    child.on("close", (code) => done({ code: code ?? -1, out }));
  });
}

// --------------------------------------------------------------------- clock

describe("telling a wrong clock from a cancelled credential", () => {
  it("TEST 7: only an explicit code means the credential is gone", () => {
    // The whole incident in one assertion: a refusal for a timestamp is not a
    // revoked credential, and must never be shown as one.
    expect(classifyCentralFailure({ status: 401, code: "TIMESTAMP_SKEW" })).toBe("CLOCK_SKEW");
    expect(classifyCentralFailure({ status: 401, code: "BAD_TIMESTAMP" })).toBe("CLOCK_SKEW");
    expect(classifyCentralFailure({ status: 403, code: "AGENT_DISABLED" })).toBe("CREDENTIAL_REVOKED");
    expect(classifyCentralFailure({ status: 401, code: "UNKNOWN_KEY" })).toBe("CREDENTIAL_REVOKED");
    // Refused, but we cannot say why - honest rather than alarming.
    expect(classifyCentralFailure({ status: 401, code: "BAD_SIGNATURE" })).toBe("AUTH_ERROR");
    expect(classifyCentralFailure({ status: 403, code: null })).toBe("AUTH_ERROR");
    expect(classifyCentralFailure({ status: 500, code: "BOOM" })).toBe("NETWORK_ERROR");
    expect(classifyCentralFailure({ status: 0, code: null })).toBe("NETWORK_ERROR");
  });

  it("TEST 1/2/3: the thresholds sit inside the replay window", () => {
    expect(clockStateFor(0)).toBe("HEALTHY");
    expect(clockStateFor(119)).toBe("HEALTHY");
    expect(clockStateFor(-119)).toBe("HEALTHY");
    // TEST 2: 200 seconds warns and repairs before signatures start failing.
    expect(clockStateFor(200)).toBe("WARNING");
    expect(clockStateFor(-200)).toBe("WARNING");
    // TEST 3: at the window itself it is an error.
    expect(clockStateFor(301)).toBe("CLOCK_SKEW");
    expect(clockStateFor(-301)).toBe("CLOCK_SKEW");
    // The security control is untouched, and the policy stays inside it.
    expect(CLOCK_SKEW_LIMIT_SECONDS).toBe(300);
    expect(CLOCK_HEALTHY_SECONDS).toBeLessThan(CLOCK_SKEW_LIMIT_SECONDS);
  });

  it("TEST 1: a healthy clock is measured and left alone", async () => {
    const { readCentralClock, healClock } = await clockModule();
    const reading = await readCentralClock(baseUrl);
    expect(reading.state).toBe("HEALTHY");
    expect(Math.abs(reading.skewSeconds)).toBeLessThan(5);

    let syncs = 0;
    const healed = await healClock(baseUrl, {
      sync: async () => {
        syncs += 1;
        return { ok: true, detail: "" };
      },
      wait: async () => undefined,
    });
    // Nothing to fix, so Windows Time is never invoked.
    expect(syncs).toBe(0);
    expect(healed.attempts).toBe(0);
    expect(healed.reading.state).toBe("HEALTHY");
  });

  it("TEST 4/5: the real incident - 41 minutes out, repaired, then reconnects", async () => {
    const { healClock } = await clockModule();
    // The PC is 41 minutes behind the centre, exactly as production was.
    central.offsetMs = 41 * 60_000;

    let syncs = 0;
    const healed = await healClock(baseUrl, {
      sync: async () => {
        syncs += 1;
        // Windows Time does its job on the first attempt.
        central.offsetMs = 0;
        return { ok: true, detail: "resync ok" };
      },
      wait: async () => undefined,
    });

    expect(syncs).toBe(1);
    expect(healed.reading.state).toBe("HEALTHY");
    expect(healed.attempts).toBe(1);
    // TEST 5: nothing here re-enrols, reinstalls or restarts anything - the
    // next signed request simply succeeds.
  });

  it("TEST 6: a clock that cannot be fixed stops trying, and says so", async () => {
    const { healClock, CLOCK_SYNC_MAX_ATTEMPTS } = await clockModule();
    central.offsetMs = 41 * 60_000; // and Windows Time never fixes it

    let syncs = 0;
    const healed = await healClock(baseUrl, {
      sync: async () => {
        syncs += 1;
        return { ok: false, detail: "The service has not been started." };
      },
      wait: async () => undefined,
    });

    // Bounded: three attempts, not a loop that runs w32tm for ever.
    expect(syncs).toBe(CLOCK_SYNC_MAX_ATTEMPTS);
    expect(healed.reading.state).toBe("CLOCK_SYNC_FAILED");
    expect(healed.detail).toContain("service");
  });

  it("TEST K: a clock error never touches identity, config or the queue", async () => {
    const { writeStatus, loadStatus } = await configModule();
    const credential = {
      agentId: "agent-1",
      keyId: "key-1",
      secret: "s".repeat(40),
      centralApiUrl: baseUrl,
      facilityId: "fac-1",
    };
    writeFileSync(join(workDir, "agent.config.json"), JSON.stringify(credential), "utf8");
    writeFileSync(
      join(workDir, "state.json"),
      JSON.stringify({ lastSyncedVisitDate: "2026-08-08", batchSequence: 41, lastSyncAt: null }),
      "utf8",
    );

    writeStatus({ centralState: "CLOCK_SKEW", clockState: "CLOCK_SKEW", clockSkewSeconds: -2460 });

    expect(JSON.parse(readFileSync(join(workDir, "agent.config.json"), "utf8"))).toEqual(credential);
    const state = JSON.parse(readFileSync(join(workDir, "state.json"), "utf8"));
    expect(state.lastSyncedVisitDate).toBe("2026-08-08");
    expect(state.batchSequence).toBe(41);
    expect(loadStatus().centralState).toBe("CLOCK_SKEW");
  });
});

// -------------------------------------------------------------------- update

describe("deciding whether to install an update", () => {
  const good = {
    available: true,
    version: "1.1.8",
    assetName: "SDCAgent-Setup-1.1.8.exe",
    size: 100,
    sha256: "a".repeat(64),
    autoInstall: true,
  };

  it("compares versions as numbers, not as text", () => {
    // The bug that would have stopped the fleet at the ninth patch.
    expect(isNewerVersion("1.1.10", "1.1.9")).toBe(true);
    expect(compareVersions("1.1.9", "1.1.10")).toBe(-1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(parseVersion("v1.1.7")).toEqual([1, 1, 7]);
    expect(parseVersion("latest")).toBeNull();
  });

  it("TEST 8: the same version does nothing at all", async () => {
    const { decideUpdate } = await updaterModule();
    expect(decideUpdate({ ...good, version: "1.1.7" }, "1.1.7").action).toBe("none");
    // and never a downgrade, however it got offered
    expect(decideUpdate({ ...good, version: "1.1.6" }, "1.1.7").action).toBe("none");
    expect(decideUpdate({ available: false, reason: "none-published" }, "1.1.7").action).toBe("none");
  });

  it("TEST 10: refuses to install anything it cannot verify", async () => {
    const { decideUpdate } = await updaterModule();
    // No hash: shown to the operator, never installed unattended.
    expect(decideUpdate({ ...good, sha256: null }, "1.1.7")).toMatchObject({ action: "blocked" });
    expect(decideUpdate({ ...good, sha256: "" }, "1.1.7")).toMatchObject({ action: "blocked" });
    expect(decideUpdate({ ...good, sha256: "short" }, "1.1.7")).toMatchObject({ action: "blocked" });
    // The server says the digest could not be trusted.
    expect(decideUpdate({ ...good, autoInstall: false }, "1.1.7")).toMatchObject({ action: "blocked" });
    // Something that is not our installer.
    expect(decideUpdate({ ...good, assetName: "payload.exe" }, "1.1.7")).toMatchObject({
      action: "blocked",
    });
    // The good case still works, or the test above proves nothing.
    expect(decideUpdate(good, "1.1.7").action).toBe("install");
  });

  it("TEST 9: downloads, verifies and keeps the file", async () => {
    const { downloadVerified } = await updaterModule();
    central.asset = randomBytes(2048);

    const path = await downloadVerified({
      baseUrl,
      version: "1.1.8",
      assetName: "SDCAgent-Setup-1.1.8.exe",
      sha256: sha256(central.asset),
      size: central.asset.length,
    });

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(central.asset);
    expect(path.includes(join("updates", "1.1.8"))).toBe(true);
  });

  it("TEST 10: a tampered download is deleted, never left to be run", async () => {
    const { downloadVerified } = await updaterModule();
    central.asset = randomBytes(2048);

    await expect(
      downloadVerified({
        baseUrl,
        version: "1.1.8",
        assetName: "SDCAgent-Setup-1.1.8.exe",
        // The hash of what was published, not of what the server just sent.
        sha256: sha256(Buffer.from("something else entirely")),
        size: central.asset.length,
      }),
    ).rejects.toThrow(/SHA-256/);

    // Nothing executable survives a failed verification - not the finished
    // name and not the partial one.
    const folder = join(workDir, "updates", "1.1.8");
    const left = existsSync(folder) ? readdirSync(folder) : [];
    expect(left).toEqual([]);
  });

  it("refuses a file of the wrong length before it even hashes it", async () => {
    const { downloadVerified } = await updaterModule();
    central.asset = randomBytes(100);
    await expect(
      downloadVerified({
        baseUrl,
        version: "1.1.8",
        assetName: "SDCAgent-Setup-1.1.8.exe",
        sha256: sha256(central.asset),
        size: 999_999,
      }),
    ).rejects.toThrow(/ขนาดไฟล์/);
  });

  it("TEST 11: an interrupted download leaves only a .part, and retrying works", async () => {
    const { downloadVerified } = await updaterModule();
    central.asset = randomBytes(4096);
    const folder = join(workDir, "updates", "1.1.8");
    const target = join(folder, "SDCAgent-Setup-1.1.8.exe");

    // Half a file, named the way an interrupted attempt leaves it.
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${target}.part`, central.asset.subarray(0, 1000));

    const path = await downloadVerified({
      baseUrl,
      version: "1.1.8",
      assetName: "SDCAgent-Setup-1.1.8.exe",
      sha256: sha256(central.asset),
      size: central.asset.length,
    });

    expect(readFileSync(path)).toEqual(central.asset);
    expect(existsSync(`${target}.part`)).toBe(false);
  });

  it("does not download again when the verified file is already there", async () => {
    const { downloadVerified } = await updaterModule();
    central.asset = randomBytes(1024);
    const args = {
      baseUrl,
      version: "1.1.8",
      assetName: "SDCAgent-Setup-1.1.8.exe",
      sha256: sha256(central.asset),
      size: central.asset.length,
    };
    await downloadVerified(args);
    expect(central.downloads).toBe(1);
    await downloadVerified(args);
    // Second call verified what was on disk instead of fetching it again.
    expect(central.downloads).toBe(1);
  });


  it("TEST 13/14: an update that fails leaves the queue and the credential alone", async () => {
    // A failed update must never cost a clinic its unsent rows. Nothing in the
    // updater writes to the queue, the credential or the watermark - proven by
    // running a download that fails and then reading them back.
    const { downloadVerified } = await updaterModule();
    const queue = join(workDir, "queue", "pending");
    mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, "chunk-1.json"), JSON.stringify({ records: [1, 2, 3] }), "utf8");
    const credential = { agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: baseUrl };
    writeFileSync(join(workDir, "agent.config.json"), JSON.stringify(credential), "utf8");
    writeFileSync(
      join(workDir, "state.json"),
      JSON.stringify({ lastSyncedVisitDate: "2026-08-08", batchSequence: 41 }),
      "utf8",
    );

    central.asset = randomBytes(512);
    await expect(
      downloadVerified({
        baseUrl,
        version: "1.1.8",
        assetName: "SDCAgent-Setup-1.1.8.exe",
        sha256: sha256(Buffer.from("wrong")),
        size: central.asset.length,
      }),
    ).rejects.toThrow();

    expect(readdirSync(queue)).toEqual(["chunk-1.json"]);
    expect(JSON.parse(readFileSync(join(workDir, "agent.config.json"), "utf8"))).toEqual(credential);
    expect(JSON.parse(readFileSync(join(workDir, "state.json"), "utf8")).batchSequence).toBe(41);
  });

  it("TEST 12: waits for a sync that is mid-flight", async () => {
    const { syncIsBusy } = await updaterModule();
    const { writeStatus } = await configModule();

    for (const phase of ["READING", "UPLOADING", "VERIFYING"] as const) {
      writeStatus({ syncPhase: phase });
      expect(syncIsBusy(), `${phase} should block an install`).toBe(true);
    }
    for (const phase of ["IDLE", "SUCCESS", "ERROR"] as const) {
      writeStatus({ syncPhase: phase });
      expect(syncIsBusy(), `${phase} should not block an install`).toBe(false);
    }
  });
});

describe("an update found while a sync is running", () => {
  it("TEST 20: waits, and says it is waiting, instead of interrupting", async () => {
    // The queue would survive an interruption, but a run that is most of the
    // way through a clinic's history should not be cut short for an update
    // that can wait an hour. Run end to end through the CLI, because the
    // decision lives there rather than in a helper.
    const { writeStatus, loadStatus } = await configModule();
    central.asset = randomBytes(1024);
    central.manifest = {
      available: true,
      version: "9.9.9",
      assetName: "SDCAgent-Setup-9.9.9.exe",
      size: central.asset.length,
      sha256: sha256(central.asset),
      autoInstall: true,
    };
    writeFileSync(
      join(workDir, "agent.config.json"),
      JSON.stringify({
        agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: baseUrl,
        facilityId: "f", expectedPcucode: "T0001", installationId: "i",
        syncIntervalMinutes: 60, reprocessDays: 7,
      }),
      "utf8",
    );
    // A sync is mid-flight.
    writeStatus({ syncPhase: "UPLOADING" });

    const result = await runCli(["auto-update"], workDir);

    expect(result.code, result.out.slice(-300)).toBe(0);
    expect(result.out).toMatch(/รอบถัดไป/);
    // Nothing was fetched and nothing was installed.
    expect(central.downloads).toBe(0);
    const status = loadStatus();
    expect(status.updateState).toBe("READY");
    expect(status.updateLatestVersion).toBe("9.9.9");
  }, 180_000);

  it("installs once the sync is idle", async () => {
    const { writeStatus, loadStatus } = await configModule();
    central.asset = randomBytes(1024);
    central.manifest = {
      available: true,
      version: "9.9.9",
      assetName: "SDCAgent-Setup-9.9.9.exe",
      size: central.asset.length,
      sha256: sha256(central.asset),
      autoInstall: true,
    };
    writeFileSync(
      join(workDir, "agent.config.json"),
      JSON.stringify({
        agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: baseUrl,
        facilityId: "f", expectedPcucode: "T0001", installationId: "i",
        syncIntervalMinutes: 60, reprocessDays: 7,
      }),
      "utf8",
    );
    writeStatus({ syncPhase: "IDLE" });

    const result = await runCli(["auto-update"], workDir);

    // It downloaded and verified, then tried to run the "installer" - which is
    // random bytes here, so the attempt fails and is reported as a failure
    // rather than pretending to have succeeded.
    expect(central.downloads).toBe(1);
    const status = loadStatus();
    expect(status.updateState).toBe("FAILED");

    // The whole chain ran under one command, unattended, with nothing asked of
    // a person: manifest -> version compare -> download -> size -> sha256 ->
    // idle check -> execute -> report. What the machine did is on the record.
    expect(status.updateLatestVersion).toBe("9.9.9");
    expect(status.autoUpdateTaskLastRunAt).toBeTruthy();
    expect(status.autoUpdateTaskLastResult).toMatch(/FAILED version=9\.9\.9/);
    // And the account that ran it, which is the only thing that separates a
    // SYSTEM scheduled task from somebody pressing the button on the window.
    expect(status.autoUpdateTaskLastResult).toMatch(/ as=\S+/);
    // The installer's own exit status, not just "it did not work". execFile
    // hides it on the error object, so it had to be lifted out deliberately.
    expect(status.updateDetail).toMatch(/ตัวติดตั้งจบด้วยรหัส/);
    void result;
  }, 180_000);

  it("records that the task ran even when there is nothing to install", async () => {
    // The reason this field exists: from outside, a task that never fired and
    // a task that fired and found nothing look identical - both leave the
    // version where it was. The canary spent an hour unable to tell which had
    // happened, with no elevated shell to ask Task Scheduler.
    const { loadStatus } = await configModule();
    central.manifest = { available: false, version: "0.0.1" };
    writeFileSync(
      join(workDir, "agent.config.json"),
      JSON.stringify({
        agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: baseUrl,
        facilityId: "f", expectedPcucode: "T0001", installationId: "i",
        syncIntervalMinutes: 60, reprocessDays: 7,
      }),
      "utf8",
    );

    await runCli(["auto-update"], workDir);

    const status = loadStatus();
    expect(status.updateState).toBe("NONE");
    expect(status.autoUpdateTaskLastRunAt).toBeTruthy();
    expect(status.autoUpdateTaskLastResult).toMatch(/^NONE /);
    expect(status.autoUpdateTaskLastResult).toMatch(/ as=\S+/);
    expect(central.downloads).toBe(0);
  }, 180_000);

  it("records that the clock task ran, and who ran it", async () => {
    const { loadStatus } = await configModule();
    // Pointed at the fake centre in this file, never at a real one.
    writeFileSync(
      join(workDir, "agent.config.json"),
      JSON.stringify({
        agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: baseUrl,
        facilityId: "f", expectedPcucode: "T0001", installationId: "i",
        syncIntervalMinutes: 60, reprocessDays: 7,
      }),
      "utf8",
    );

    await runCli(["time-sync"], workDir);

    const status = loadStatus();
    expect(status.timeSyncTaskLastRunAt).toBeTruthy();
    expect(status.timeSyncTaskLastResult).toMatch(/^HEALTHY skew=/);
    expect(status.timeSyncTaskLastResult).toMatch(/ as=\S+/);
    // Same field the ordinary reading writes, so the screen is unaffected.
    expect(status.lastClockCheckAt).toBeTruthy();
  }, 180_000);
});

/**
 * The whole update, end to end, against a real executable.
 *
 * Everything above tests the pieces. This runs the actual `agent auto-update`
 * command against a local manifest and a file that really is launched, so the
 * exit code is a number Windows produced rather than one a mock returned.
 *
 * The "installer" is a compiled stub that records the arguments it was given
 * and exits with whatever this file asks for. It never touches this machine's
 * installation, and no GitHub Release has to exist for any of it.
 */
describe("the update a clinic would actually get", () => {
  let stub: Buffer | null = null;
  let marker = "";

  beforeAll(() => {
    const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    if (process.platform !== "win32" || !existsSync(csc)) return;
    const dir = mkdtempSync(resolve(tmpdir(), "sdc-stub-"));
    const source = join(dir, "stub.cs");
    const exe = join(dir, "stub.exe");
    writeFileSync(
      source,
      [
        "using System; using System.IO;",
        "class Stub { static int Main(string[] args) {",
        "  var m = Environment.GetEnvironmentVariable(\"STUB_MARKER\");",
        "  if (!string.IsNullOrEmpty(m)) File.AppendAllText(m, string.Join(\" \", args));",
        "  var c = Environment.GetEnvironmentVariable(\"STUB_EXIT\");",
        "  return string.IsNullOrEmpty(c) ? 0 : int.Parse(c);",
        "} }",
      ].join("\n"),
      "utf8",
    );
    const built = spawnSync(csc, ["/nologo", "/target:exe", `/out:${exe}`, source], {
      encoding: "utf8",
    });
    if (built.status === 0 && existsSync(exe)) stub = readFileSync(exe);
  }, 120_000);

  const enrol = () =>
    writeFileSync(
      join(workDir, "agent.config.json"),
      JSON.stringify({
        agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: baseUrl,
        facilityId: "f", expectedPcucode: "T0001", installationId: "i",
        syncIntervalMinutes: 60, reprocessDays: 7,
      }),
      "utf8",
    );

  const offer = (overrides: Record<string, unknown> = {}) => {
    central.asset = Buffer.from(stub ?? []);
    central.manifest = {
      available: true,
      version: "9.9.9",
      assetName: "SDCAgent-Setup-9.9.9.exe",
      size: central.asset.length,
      sha256: sha256(central.asset),
      autoInstall: true,
      ...overrides,
    };
  };

  beforeEach(() => {
    marker = join(workDir, "launched.txt");
    process.env.STUB_MARKER = marker;
    delete process.env.STUB_EXIT;
  });

  afterEach(() => {
    delete process.env.STUB_MARKER;
    delete process.env.STUB_EXIT;
  });

  it("checks, downloads, verifies and runs it - exit code 0", async () => {
    if (!stub) return;
    const { writeStatus, loadStatus } = await configModule();
    enrol();
    offer();
    writeStatus({ syncPhase: "IDLE" });

    await runCli(["auto-update"], workDir);

    // It fetched the manifest, decided 9.9.9 beats this build, downloaded
    // once, and checked what it got before running anything.
    expect(central.downloads).toBe(1);
    // Then it really launched it, with the arguments the elevated path uses -
    // and without /SUPPRESSMSGBOXES, which once answered Inno's own questions
    // with Cancel three times in a row.
    const launched = readFileSync(marker, "utf8");
    expect(launched).toContain("/VERYSILENT");
    expect(launched).toContain("/NORESTART");
    expect(launched).toContain("/LOG=");
    expect(launched).not.toContain("/SUPPRESSMSGBOXES");

    const status = loadStatus();
    expect(status.autoUpdateTaskLastResult).toMatch(/INSTALLED version=9\.9\.9/);
    expect(status.updateState).toBe("READY");
    expect(status.updateDetail).toBe("ติดตั้งแล้ว รอเริ่มโปรแกรมใหม่");

    // Nothing half-written left behind for a later run to pick up.
    const updates = join(workDir, "updates");
    const leftovers = existsSync(updates) ? readdirSync(updates) : [];
    expect(leftovers.filter((name) => name.endsWith(".part"))).toEqual([]);
  }, 180_000);

  it("a file whose hash is wrong is never launched", async () => {
    if (!stub) return;
    const { writeStatus, loadStatus } = await configModule();
    enrol();
    // The centre - or something pretending to be it - offers a hash that does
    // not belong to the bytes it serves. HTTPS proves who sent the file, not
    // that the file is the one that was published.
    offer({ sha256: "0".repeat(64) });
    writeStatus({ syncPhase: "IDLE" });

    await runCli(["auto-update"], workDir);

    expect(central.downloads).toBe(1);
    // The only assertion that really matters here.
    expect(existsSync(marker)).toBe(false);
    expect(loadStatus().updateState).toBe("FAILED");
    // And the file it could not vouch for is gone, not left where the next
    // run - or anything else - could execute it.
    const updates = join(workDir, "updates");
    const kept = existsSync(updates) ? readdirSync(updates) : [];
    expect(kept.filter((name) => name.endsWith(".exe"))).toEqual([]);
  }, 180_000);

  it("an installer that refuses reports the number it refused with", async () => {
    if (!stub) return;
    const { writeStatus, loadStatus } = await configModule();
    enrol();
    offer();
    writeStatus({ syncPhase: "IDLE" });
    // 1641 is a real Inno/MSI code. The point is the number survives.
    process.env.STUB_EXIT = "1641";

    await runCli(["auto-update"], workDir);

    expect(readFileSync(marker, "utf8")).toContain("/VERYSILENT");
    const status = loadStatus();
    expect(status.updateState).toBe("FAILED");
    expect(status.updateDetail).toContain("1641");
    expect(status.autoUpdateTaskLastResult).toMatch(/FAILED version=9\.9\.9/);
    expect(status.autoUpdateTaskLastResult).toContain("1641");
  }, 180_000);

  it("will not start an installer while a sync is running", async () => {
    if (!stub) return;
    const { writeStatus, loadStatus } = await configModule();
    enrol();
    offer();
    writeStatus({ syncPhase: "UPLOADING" });

    await runCli(["auto-update"], workDir);

    // Not downloaded, not launched, and it said why rather than going quiet.
    expect(central.downloads).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const status = loadStatus();
    expect(status.updateState).toBe("READY");
    expect(status.updateDetail).toBe("รอการซิงก์ปัจจุบันเสร็จก่อนติดตั้ง");
    expect(status.autoUpdateTaskLastResult).toMatch(/WAITING_FOR_SYNC/);

    // One check, one decision. A run that finds a busy agent must not sit
    // there retrying - the next scheduled check is hours away, and fifteen
    // clinics doing that at once is a queue nobody asked for.
    await runCli(["auto-update"], workDir);
    expect(central.downloads).toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 180_000);
});

describe("fifteen clinics updating at once", () => {
  it("TEST 16: installs are spread, deterministically and without collisions", async () => {
    const { updateOffsetSeconds, UPDATE_STAGGER_SECONDS } = await import(
      `../agent/src/schedule?s=${counter++}`
    );

    const ids = Array.from({ length: 15 }, (_, i) => `01m2agent${String(i).padStart(4, "0")}xyz`);
    const offsets = ids.map((id) => updateOffsetSeconds(id));

    // Inside the window, and not all in the same minute.
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(UPDATE_STAGGER_SECONDS);
    }
    expect(UPDATE_STAGGER_SECONDS).toBe(30 * 60);
    expect(new Set(offsets).size).toBeGreaterThanOrEqual(14);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(5 * 60);

    // Stable: the same clinic takes the same slot on every release, so two of
    // them cannot drift into restarting together.
    expect(ids.map((id) => updateOffsetSeconds(id))).toEqual(offsets);
  });

  it("TEST 15: one clinic's clock says nothing about another's", async () => {
    // Each agent keeps its clock reading in its own data directory, so a
    // skewed PC cannot mark the other fourteen as skewed.
    const homes = Array.from({ length: 3 }, () => mkdtempSync(resolve(tmpdir(), "sdc-fleet-clock-")));
    try {
      const states: string[] = [];
      for (const [index, home] of homes.entries()) {
        process.env.AGENT_DATA_DIR = home;
        const { writeStatus, loadStatus } = await configModule();
        writeStatus({
          clockState: index === 1 ? "CLOCK_SKEW" : "HEALTHY",
          clockSkewSeconds: index === 1 ? -2460 : 1,
        });
        states.push(loadStatus().clockState);
      }
      expect(states).toEqual(["HEALTHY", "CLOCK_SKEW", "HEALTHY"]);
    } finally {
      for (const home of homes) rmSync(home, { recursive: true, force: true });
      process.env.AGENT_DATA_DIR = workDir;
    }
  });
});
