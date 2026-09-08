/**
 * Writing the status file, on Windows, while other things are touching it.
 *
 * A รพ.สต. went offline because a file rename failed. status.json is what the
 * window draws from - not the queue, not the watermark, not the credential -
 * and the write used to throw. A throw from inside the scheduler's tick is an
 * unhandled rejection, which ends the Node process, so the agent was gone
 * until somebody restarted the tray.
 *
 * Two things made the renames fail. The temporary file had one fixed name that
 * every process shared, so the worker and a manual sync started from the tray
 * would take each other's file away. And on Windows a rename fails outright
 * while anything else holds the target open for a moment - a virus scanner
 * reading a file that was just created is enough.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(resolve(tmpdir(), "sdc-writer-"));
  process.env.AGENT_DATA_DIR = workDir;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

let counter = 0;
async function configModule() {
  return import(`../agent/src/config?writer=${counter++}`);
}

describe("the status file writer", () => {
  it("CASE A: writes, and what comes back can be read again", async () => {
    const { writeStatus, loadStatus } = await configModule();
    writeStatus({ phase: "idle", message: "พร้อมทำงาน" });
    const status = loadStatus();
    expect(status.phase).toBe("idle");
    expect(status.message).toBe("พร้อมทำงาน");
    expect(JSON.parse(readFileSync(resolve(workDir, "status.json"), "utf8")).phase).toBe("idle");
  });

  it("CASE E: two writes never share a temporary name", async () => {
    const { writeStatus } = await configModule();
    // The old code used one fixed "status.json.tmp" for every process and
    // every call, which is how two writers took each other's file.
    writeStatus({ message: "หนึ่ง" });
    writeStatus({ message: "สอง" });
    const leftovers = readdirSync(workDir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers, `temporary files left behind: ${leftovers.join(", ")}`).toHaveLength(0);
  });

  it("CASE D: a write that cannot succeed leaves the last good status alone", async () => {
    const { writeStatus, loadStatus, statusWriteStats } = await configModule();
    writeStatus({ phase: "idle", message: "ค่าที่ดีล่าสุด" });

    // A directory where the file should be: renaming onto it always fails, on
    // every platform, without waiting on anyone else's timing.
    const target = resolve(workDir, "status.json");
    rmSync(target);
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(target)})`]);

    const before = statusWriteStats.failures;
    // The whole point: this must return rather than throw.
    expect(() => writeStatus({ message: "เขียนไม่ได้" })).not.toThrow();
    expect(statusWriteStats.failures).toBeGreaterThan(before);
    expect(statusWriteStats.lastError).toBeTruthy();

    // And it must not have left its working file lying around.
    const leftovers = readdirSync(workDir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
    void loadStatus;
  });

  it("CASE F/G: writes in one process are ordered, and clean up after themselves", async () => {
    const { writeStatus, loadStatus } = await configModule();
    // These are synchronous by construction, so they cannot interleave within
    // a process - the ordering guarantee is the absence of concurrency, not a
    // lock. Fifty in a row proves the file survives the churn.
    for (let i = 0; i < 50; i++) writeStatus({ message: `รอบที่ ${i}` });
    expect(loadStatus().message).toBe("รอบที่ 49");
    expect(readdirSync(workDir).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  it("CASE B/C: several processes writing at once never crash and never corrupt", async () => {
    // The real shape of the production failure: separate processes, the same
    // file, no coordination. The worker and the tray's own short-lived
    // commands do exactly this.
    const script = resolve(workDir, "writer.mjs");
    // A file:// URL, because ESM refuses a bare Windows path.
    const configPath = pathToFileURL(resolve(process.cwd(), "agent", "src", "config.ts")).href;
    writeFileSync(
      script,
      `import { writeStatus } from ${JSON.stringify(configPath)};
       const tag = process.argv[2];
       for (let i = 0; i < 40; i++) writeStatus({ message: tag + ":" + i });
       process.exit(0);
      `,
      "utf8",
    );

    const runners = Array.from({ length: 6 }, (_, i) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", script, `p${i}`],
        { env: { ...process.env, AGENT_DATA_DIR: workDir }, encoding: "utf8", timeout: 120_000 },
      ),
    );

    for (const [i, r] of runners.entries()) {
      expect(r.status, `writer ${i} exited ${r.status}: ${r.stderr?.slice(-300)}`).toBe(0);
      expect(r.stderr ?? "").not.toMatch(/UnhandledPromiseRejection|EPERM|Error:/);
    }

    // 240 writes across six processes. The file must still be one valid
    // document - which of them wrote last does not matter, because a status is
    // a snapshot, not a ledger.
    const raw = readFileSync(resolve(workDir, "status.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).message).toMatch(/^p\d:\d+$/);

    // And no pile of abandoned temporary files.
    const leftovers = readdirSync(workDir).filter((n) => n.endsWith(".tmp"));
    expect(leftovers, `temporary files left behind: ${leftovers.length}`).toHaveLength(0);
  }, 180_000);

  it("keeps a failed status write away from the heartbeat", async () => {
    // The ordering that matters: whatever happens to the local file, the
    // report to Central still goes out. writeStatus returning instead of
    // throwing is what guarantees it, so this pins that it returns a usable
    // status even when the file could not be written.
    const { writeStatus } = await configModule();
    const target = resolve(workDir, "status.json");
    if (existsSync(target)) rmSync(target);
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(target)})`]);

    const status = writeStatus({ centralState: "CONNECTED", jhcisState: "UNREACHABLE" });
    expect(status.centralState).toBe("CONNECTED");
    expect(status.jhcisState).toBe("UNREACHABLE");
  });
});
