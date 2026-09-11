/**
 * Checking for updates every thirty minutes, without the fleet doing it at once.
 *
 * v1.1.9 changes one number - the AutoUpdate task fires every 30 minutes
 * instead of every 4 hours - and adds one property: each clinic checks at its
 * own minute within the half hour, decided by a stable hash of its identity,
 * so fifteen machines do not become one request burst.
 *
 * Everything below is the proof that the change is only that. A check that
 * finds no update must download nothing, open no batch, touch neither JHCIS
 * nor the watermark, and must keep working while sync is paused - a paused
 * clinic is exactly the one that needs to be able to receive a fix.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ISS = resolve(process.cwd(), "agent", "installer", "sdc-agent.iss");
const CLI = resolve(process.cwd(), "agent", "src", "cli.ts");

/* ------------------------------------------------- the task the installer writes */

describe("the scheduled task the installer writes", () => {
  const source = () => readFileSync(ISS, "utf8");

  it("1. a new installation gets the 30-minute cadence", () => {
    const create = /\/Create \/F \/TN "SDCAgentAutoUpdate"[^\n]*/.exec(source())?.[0] ?? "";
    expect(create).toContain("/SC MINUTE /MO 30");
    expect(create).not.toContain("HOURLY");
    // Anchored to this machine's slot, not to whenever the installer happened
    // to run.
    expect(create).toContain("/ST ' + startAt");
  });

  it("2./3. upgrading over v1.1.7 or v1.1.8 replaces the 4-hour task in place", () => {
    // /F is what makes an upgrade a replacement: schtasks overwrites the task
    // of the same name rather than refusing or adding a second one. Both
    // earlier releases created the task under this exact name, so the new
    // definition lands on top of either.
    const create = /\/Create \/F \/TN "SDCAgentAutoUpdate"/.exec(source());
    expect(create).toBeTruthy();
    for (const tag of ["v1.1.7", "v1.1.8"]) {
      const old = spawnSync("git", ["show", `${tag}:agent/installer/sdc-agent.iss`], {
        encoding: "utf8",
      }).stdout;
      expect(old, `${tag} should be readable from git`).toContain('/TN "SDCAgentAutoUpdate"');
      expect(old).toContain("/SC HOURLY /MO 4");
    }
  });

  it("4. never creates a duplicate task", () => {
    const creates = source().match(/\/Create \/F \/TN "SDCAgentAutoUpdate"/g) ?? [];
    expect(creates).toHaveLength(1);
    // And the uninstaller removes exactly that name, so a remove/reinstall
    // cycle cannot accumulate copies either.
    expect(source().match(/\/Delete \/TN "SDCAgentAutoUpdate" \/F/g) ?? []).toHaveLength(1);
  });

  it("11. touches only its own two tasks", () => {
    const names = new Set(
      [...source().matchAll(/\/TN "([^"]+)"/g)].map((m) => m[1]),
    );
    // Its two tasks, plus the legacy "SDC Agent" task that pre-1.1 builds
    // created and which the installer deletes by that fixed name.
    expect([...names].sort()).toEqual(["SDCAgentAutoUpdate", "SDCAgentTimeSync", "{#AppNameEn}"]);
    // Nothing that enumerates or edits arbitrary tasks.
    expect(source()).not.toMatch(/schtasks[^\n]*\/Query/i);
    expect(source()).not.toMatch(/schtasks[^\n]*\/Change/i);
  });

  it("13. stays a SYSTEM task with a fixed command line", () => {
    const create = /\/Create \/F \/TN "SDCAgentAutoUpdate"[^\n]*\n[^\n]*\n[^\n]*/.exec(source())?.[0] ?? "";
    expect(create).toContain("/RU SYSTEM /RL HIGHEST");
    expect(create).toContain("auto-update");
    // The installer itself is what the updater runs, silently, no restart, no
    // message-box suppression (which turned Inno's questions into Cancel).
    const updater = readFileSync(resolve(process.cwd(), "agent", "src", "updater.ts"), "utf8");
    expect(updater).toContain('"/VERYSILENT", "/NORESTART"');
    expect(updater).not.toContain("SUPPRESSMSGBOXES\"");
  });

  it("only accepts a slot of the form 00:MM with MM in 00-29", () => {
    // The installer validates what the program prints rather than trusting it,
    // and falls back to 00:00 - still every 30 minutes, just unstaggered.
    const fn = source().slice(source().indexOf("function UpdateCheckStartTime"));
    expect(fn).toContain("Result := '00:00';");
    expect(fn).toContain("(Copy(raw, 1, 3) = '00:')");
    expect(fn).toContain("<= 29");
  });
});

/* ------------------------------------------------------------- the stagger */

describe("deterministic staggering", () => {
  it("5. spreads many identities across the half hour", async () => {
    const { updateCheckSlotMinute, updateCheckStartTime, UPDATE_CHECK_INTERVAL_MINUTES } =
      await import("../agent/src/schedule");
    expect(UPDATE_CHECK_INTERVAL_MINUTES).toBe(30);

    // Ids allocated in sequence, which is how they are allocated.
    const ids = Array.from({ length: 15 }, (_, i) => `01m2agent${String(i).padStart(4, "0")}`);
    const minutes = ids.map((id) => updateCheckSlotMinute(id));
    for (const m of minutes) {
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(30);
    }
    // Not a thundering herd: fifteen sequential ids must not collapse into a
    // handful of minutes. With 30 slots the expected number of distinct
    // minutes for 15 draws is about 12; anything under 8 would mean the hash
    // is not doing its job.
    expect(new Set(minutes).size).toBeGreaterThanOrEqual(8);

    // And the start time is the same minute, formatted for schtasks.
    for (const id of ids) {
      const start = updateCheckStartTime(id);
      expect(start).toMatch(/^00:[0-2][0-9]$/);
      expect(Number(start.slice(3))).toBe(updateCheckSlotMinute(id));
    }
  });

  it("6. gives the same Agent the same slot every time", async () => {
    const { updateCheckSlotMinute } = await import("../agent/src/schedule");
    const id = "01m21zsrspzmv8vxja3daw1wfj"; // RPST-05957's real id
    const first = updateCheckSlotMinute(id);
    for (let i = 0; i < 50; i++) expect(updateCheckSlotMinute(id)).toBe(first);
    // Stable across a fresh load of the module too, as a restart would be.
    const again = await import(`../agent/src/schedule?again=${Date.now()}`);
    expect(again.updateCheckSlotMinute(id)).toBe(first);
  });

  it("prints the slot through the CLI, from the enrolled id or the hostname", async () => {
    const { updateCheckSlotMinute } = await import("../agent/src/schedule");
    const home = mkdtempSync(resolve(tmpdir(), "sdc-slot-"));
    try {
      // Not enrolled: the hostname stands in. Still a valid, stable slot.
      const bare = spawnSync(process.execPath, ["--import", "tsx", CLI, "update-slot"], {
        env: { ...process.env, AGENT_DATA_DIR: home },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(bare.status, bare.stderr).toBe(0);
      expect(bare.stdout.trim()).toMatch(/^00:[0-2][0-9]$/);

      // Enrolled: the agentId decides, and the answer matches the library.
      writeFileSync(
        join(home, "agent.config.json"),
        JSON.stringify({
          agentId: "01m21zsrspzmv8vxja3daw1wfj", keyId: "k", secret: "s".repeat(40),
          centralApiUrl: "https://central.invalid/", facilityId: "f", facilityCode: "T",
          expectedPcucode: "T0001", installationId: "i", syncIntervalMinutes: 60, reprocessDays: 7,
        }),
      );
      const enrolled = spawnSync(process.execPath, ["--import", "tsx", CLI, "update-slot"], {
        env: { ...process.env, AGENT_DATA_DIR: home },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(enrolled.status, enrolled.stderr).toBe(0);
      expect(enrolled.stdout.trim()).toBe(
        "00:" + String(updateCheckSlotMinute("01m21zsrspzmv8vxja3daw1wfj")).padStart(2, "0"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});

/* ------------------------------------------------ what a check must not do */

/**
 * A real `agent auto-update` process against a counting Central, with JHCIS
 * pointed at a port nothing listens on - so any read at all would fail loudly
 * rather than quietly succeed against something real.
 */
let home: string;
let central: Server;
let hits: string[];
let manifest: Record<string, unknown>;

beforeEach(async () => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-update-"));
  hits = [];
  manifest = { available: true, version: "1.1.9", assetName: "SDCAgent-Setup-1.1.9.exe",
    size: 1, sha256: "a".repeat(64), autoInstall: true };
  central = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/api/agent/update")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end("not an installer");
  });
  await new Promise<void>((done) => central.listen(0, "127.0.0.1", done));
  const port = (central.address() as { port: number }).port;

  writeFileSync(join(home, "agent.config.json"), JSON.stringify({
    agentId: "a", keyId: "k", secret: "s".repeat(40),
    centralApiUrl: `http://127.0.0.1:${port}/`, facilityId: "f", facilityCode: "T",
    expectedPcucode: "T0001", installationId: "i", syncIntervalMinutes: 60, reprocessDays: 7,
  }));
  writeFileSync(join(home, "jhcis.json"), JSON.stringify({
    host: "127.0.0.1", port: 1, database: "none", user: "root", password: "",
  }));
});

afterEach(async () => {
  await new Promise<void>((done) => central.close(() => done()));
  rmSync(home, { recursive: true, force: true });
});

/**
 * Spawned asynchronously on purpose: the counting Central lives in this same
 * process, and spawnSync would block the event loop that has to answer it.
 */
function runAutoUpdate(): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "auto-update"], {
      env: { ...process.env, AGENT_DATA_DIR: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

function state() {
  return JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
}

describe("a check that finds nothing new", () => {
  it("8./9./10. downloads nothing, reads no JHCIS, and moves no sync state", async () => {
    const before = { lastSyncedVisitDate: "2026-09-10", lastSyncAt: null, batchSequence: 7 };
    writeFileSync(join(home, "state.json"), JSON.stringify(before));

    const result = await runAutoUpdate();
    expect(result.status, result.stderr).toBe(0);

    // Exactly one request, to the manifest, and nothing else - no download.
    expect(hits).toEqual(["GET /api/agent/update"]);
    const updates = join(home, "updates");
    expect(existsSync(updates) ? readdirSync(updates).length : 0).toBe(0);
    // No batch opened, no watermark moved.
    expect(state()).toMatchObject(before);
    // A JHCIS read would have thrown against port 1; none did.
    expect(result.stderr).not.toMatch(/ECONNREFUSED|JHCIS/);
    // And the local status records the check without inventing an update.
    const status = JSON.parse(readFileSync(join(home, "status.json"), "utf8"));
    expect(status.updateState).toBe("NONE");
    expect(status.autoUpdateTaskLastResult).toMatch(/^NONE latest=1\.1\.9 running=1\.1\.9/);
  }, 180_000);

  it("7. still checks while sync is paused by the centre", async () => {
    writeFileSync(join(home, "state.json"), JSON.stringify({
      lastSyncedVisitDate: "2026-09-10", lastSyncAt: null, batchSequence: 7,
      syncControlState: "PAUSED", appliedControlRevision: 3, pauseReason: "เตรียมล้างข้อมูล",
    }));

    const result = await runAutoUpdate();
    expect(result.status, result.stderr).toBe(0);
    // The check happened - a paused clinic must still be able to receive a
    // fix - and pausing changed nothing about what it did.
    expect(hits).toEqual(["GET /api/agent/update"]);
    expect(state().syncControlState).toBe("PAUSED");
  }, 180_000);
});

describe("a check that finds a newer release", () => {
  it("12. waits for an active sync rather than interrupting it", async () => {
    manifest = { ...manifest, version: "9.9.9" };
    writeFileSync(join(home, "state.json"), JSON.stringify({
      lastSyncedVisitDate: "2026-09-10", lastSyncAt: null, batchSequence: 7,
    }));
    // A run in flight, as the tray or scheduler would have left it.
    writeFileSync(join(home, "status.json"), JSON.stringify({ syncPhase: "UPLOADING" }));

    const result = await runAutoUpdate();
    expect(result.status, result.stderr).toBe(0);
    // It looked, saw the sync, and did not download.
    expect(hits).toEqual(["GET /api/agent/update"]);
    const status = JSON.parse(readFileSync(join(home, "status.json"), "utf8"));
    expect(status.updateState).toBe("READY");
    expect(status.autoUpdateTaskLastResult).toMatch(/^WAITING_FOR_SYNC version=9\.9\.9/);
    expect(status.syncPhase).toBe("UPLOADING");
  }, 180_000);
});

/* ------------------------------------------------- the suite's own hygiene */

describe("test data-dir isolation", () => {
  it("never resolves to the installed Agent, even after a test deletes the variable", async () => {
    const forbidden = /programdata[\\/]+sdcagent/i;
    delete process.env.AGENT_DATA_DIR;
    expect(process.env.AGENT_DATA_DIR).toBeTruthy();
    expect(process.env.AGENT_DATA_DIR).not.toMatch(forbidden);

    const { dataDir } = await import(`../agent/src/config?iso=${Date.now()}`);
    expect(dataDir()).not.toMatch(forbidden);

    // And it cannot be pointed there on purpose either.
    expect(() => {
      process.env.AGENT_DATA_DIR = "C:\\ProgramData\\SDCAgent";
    }).toThrow(/Refusing/);
  });
});
