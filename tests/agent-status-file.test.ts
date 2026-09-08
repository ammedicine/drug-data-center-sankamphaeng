/**
 * status.json is the contract between the Agent and the desktop app, and the
 * two are upgraded separately: a new tray will read a file written by an old
 * agent, and an old tray will read one written by a new agent. Neither may
 * crash or invent numbers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(resolve(tmpdir(), "sdc-status-"));
  process.env.AGENT_DATA_DIR = workDir;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

async function statusModule() {
  // Imported per test so dataDir() picks up the temp directory above.
  return import(`../agent/src/config?${Date.now()}`);
}

describe("status.json compatibility", () => {
  it("fills in every new field when the file predates them", async () => {
    const { loadStatus, statusPath } = await statusModule();
    // Exactly what an agent before this change wrote.
    writeFileSync(
      statusPath(),
      JSON.stringify({
        phase: "done",
        message: "ซิงก์สำเร็จ",
        total: 10,
        extracted: 10,
        uploaded: 10,
        pendingChunks: 0,
        batchRef: "SYNC-1",
        jhcisConnected: true,
        centralConnected: true,
        lastSyncAt: "2026-09-05T00:00:00.000Z",
        lastError: null,
        updatedAt: "2026-09-05T00:00:00.000Z",
      }),
      "utf8",
    );

    const status = loadStatus();
    expect(status.message).toBe("ซิงก์สำเร็จ");
    // New fields are present and neutral rather than undefined.
    expect(status.centralState).toBe("UNKNOWN");
    expect(status.jhcisState).toBe("UNKNOWN");
    expect(status.syncPhase).toBe("IDLE");
    expect(status.rangeFrom).toBeNull();
    expect(status.recordsAccepted).toBe(0);
    expect(status.centralAckAt).toBeNull();
  });

  it("survives a truncated or unreadable file", async () => {
    const { loadStatus, statusPath } = await statusModule();
    writeFileSync(statusPath(), '{"phase":"upl', "utf8");
    const status = loadStatus();
    expect(status.phase).toBe("idle");
    expect(status.centralState).toBe("UNKNOWN");
  });

  it("keeps unknown fields from a newer agent instead of dropping them", async () => {
    const { loadStatus, statusPath, writeStatus } = await statusModule();
    writeFileSync(statusPath(), JSON.stringify({ phase: "idle", futureField: 42 }), "utf8");
    expect((loadStatus() as Record<string, unknown>).futureField).toBe(42);
    writeStatus({ message: "hello" });
    expect((loadStatus() as Record<string, unknown>).futureField).toBe(42);
  });

  it("records range and counts as fields, not as prose to be parsed", async () => {
    const { loadStatus, writeStatus } = await statusModule();
    writeStatus({
      syncPhase: "READING",
      rangeFrom: "2026-08-01",
      rangeTo: "2026-08-08",
      recordsExpected: 354,
      recordsExtracted: 100,
      recordsUploaded: 50,
      recordsAccepted: 48,
      recordsRejected: 2,
    });
    const status = loadStatus();
    expect(status.rangeFrom).toBe("2026-08-01");
    expect(status.rangeTo).toBe("2026-08-08");
    expect(status.recordsExpected).toBe(354);
    // uploaded and accepted are different numbers and must stay different.
    expect(status.recordsUploaded).toBe(50);
    expect(status.recordsAccepted).toBe(48);
    expect(status.recordsRejected).toBe(2);
  });
});

/**
 * Where an upgraded agent keeps its data.
 *
 * The installer writes {app}\.env only when the file is absent, so a machine
 * upgraded from an old release can still carry AGENT_DATA_DIR=./data. The
 * agent runs with cwd={app}, so that resolves inside Program Files - a folder
 * no staff account may write to - while the tray falls back to ProgramData.
 * Two processes, two folders, and a queue nobody can see.
 *
 * resolveDataDir is pure, so these can be checked without creating anything
 * under Program Files.
 */
describe("data directory on an upgraded install", () => {
  const APP = "C:\\Program Files\\SDC Agent";
  const WINDOWS: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    ProgramData: "C:\\ProgramData",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };

  async function resolver() {
    const module = await import(`../agent/src/config?datadir=${Date.now()}`);
    return module.resolveDataDir as (
      env: NodeJS.ProcessEnv,
      platform: NodeJS.Platform,
      base: string,
    ) => string;
  }

  it("refuses a legacy relative setting that lands in Program Files", async () => {
    const resolveDataDir = await resolver();
    for (const legacy of ["./data", "data", ".\\data"]) {
      expect(
        resolveDataDir({ ...WINDOWS, AGENT_DATA_DIR: legacy }, "win32", APP),
        `${legacy} must not be honoured inside Program Files`,
      ).toBe("C:\\ProgramData\\SDCAgent");
    }
  });

  it("keeps a deliberate absolute folder on another drive", async () => {
    const resolveDataDir = await resolver();
    expect(resolveDataDir({ ...WINDOWS, AGENT_DATA_DIR: "D:\\SDCAgentData" }, "win32", APP)).toBe(
      "D:\\SDCAgentData",
    );
  });

  it("uses the folder the tray passes, which is the one the tray reads", async () => {
    const resolveDataDir = await resolver();
    expect(resolveDataDir({ ...WINDOWS, AGENT_DATA_DIR: "C:\\ProgramData\\SDCAgent" }, "win32", APP)).toBe(
      "C:\\ProgramData\\SDCAgent",
    );
  });

  it("falls back to ProgramData when nothing is set", async () => {
    const resolveDataDir = await resolver();
    expect(resolveDataDir({ ...WINDOWS }, "win32", APP)).toBe("C:\\ProgramData\\SDCAgent");
  });

  it("leaves a developer checkout alone", async () => {
    const resolveDataDir = await resolver();
    // The same ./data that is refused inside Program Files is exactly how a
    // developer runs the agent from the repository, and must keep working.
    expect(resolveDataDir({ ...WINDOWS, AGENT_DATA_DIR: "./data" }, "win32", "C:\\repo\\agent")).toBe(
      "C:\\repo\\agent\\data",
    );
  });
});
