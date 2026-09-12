/**
 * The command's journey through the worker's heartbeat.
 *
 * The centre answers a heartbeat with `updateCommand`; the worker must write
 * it to disk before anything else (that file is what the SYSTEM task acts on),
 * ask the task to run, and on later heartbeats tell the centre how the file
 * changed - but only when it changed. All of it through the real
 * SyncRunner.heartbeat() against a counting Central; JHCIS is a port nothing
 * listens on, so the heartbeat reports it down rather than reading anything.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let central: Server;
let bodies: Array<Record<string, unknown>>;
let reply: Record<string, unknown> | null;
let counter = 0;

const config = {
  facilityId: "FAC",
  facilityCode: "RPST-05957",
  facilityName: "test",
  expectedPcucode: "05957",
  syncIntervalMinutes: 60,
  reprocessDays: 7,
  // Matches the local watermark: a NULL here is the centre's purge signal and
  // would pull the local value back on purpose, which is not what this file
  // is testing.
  lastSyncedVisitDate: "2026-09-10",
  uploadChunkSize: 500,
  disabled: false,
  syncRequested: false,
  verifyRequested: false,
};

beforeEach(async () => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-deliver-"));
  process.env.AGENT_DATA_DIR = home;
  bodies = [];
  reply = null;
  central = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      if ((req.url ?? "").endsWith("/heartbeat")) bodies.push(JSON.parse(Buffer.concat(parts).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, config: { ...config, updateCommand: reply } }));
    });
  });
  await new Promise<void>((d) => central.listen(0, "127.0.0.1", d));
  const port = (central.address() as { port: number }).port;
  writeFileSync(join(home, "agent.config.json"), JSON.stringify({
    agentId: "a", keyId: "k", secret: "s".repeat(40), centralApiUrl: `http://127.0.0.1:${port}/`,
    facilityId: "FAC", facilityCode: "RPST-05957", expectedPcucode: "05957", installationId: "i",
    syncIntervalMinutes: 60, reprocessDays: 7,
  }));
  writeFileSync(join(home, "jhcis.json"), JSON.stringify({ host: "127.0.0.1", port: 1, database: "none", user: "root", password: "" }));
  writeFileSync(join(home, "state.json"), JSON.stringify({ lastSyncedVisitDate: "2026-09-10", lastSyncAt: null, batchSequence: 4 }));
});

afterEach(async () => {
  await new Promise<void>((d) => central.close(() => d()));
  rmSync(home, { recursive: true, force: true });
});

const runner = async () => {
  const { SyncRunner } = await import(`../agent/src/sync?d=${counter++}`);
  return new SyncRunner();
};

describe("receiving a command", () => {
  it("writes it to disk as DELIVERED before anything else, once, and reports it on the next heartbeat", async () => {
    const r = await runner();
    await r.heartbeat("ONLINE");
    expect(existsSync(join(home, "update-command.json"))).toBe(false);
    // The first heartbeat of a process reports the updater once, even if
    // there is nothing to say - the centre learns the report shape exists.
    expect(bodies[0].update).toBeDefined();

    reply = { id: "cmd-9", targetVersion: "9.9.9", assetName: "SDCAgent-Setup-9.9.9.exe", size: 10, sha256: "c".repeat(64) };
    await r.heartbeat("ONLINE");
    const file = JSON.parse(readFileSync(join(home, "update-command.json"), "utf8"));
    expect(file).toMatchObject({ commandId: "cmd-9", targetVersion: "9.9.9", state: "DELIVERED", sha256: "c".repeat(64) });

    // Next heartbeat carries the new state; the one after that, unchanged, carries nothing.
    await r.heartbeat("ONLINE");
    expect((bodies[2].update as Record<string, unknown>).commandId).toBe("cmd-9");
    expect((bodies[2].update as Record<string, unknown>).state).toBe("DELIVERED");
    await r.heartbeat("ONLINE");
    expect(bodies[3].update).toBeUndefined();

    // The same command repeated by the centre changes nothing on disk.
    const before = readFileSync(join(home, "update-command.json"), "utf8");
    await r.heartbeat("ONLINE");
    expect(readFileSync(join(home, "update-command.json"), "utf8")).toBe(before);
  }, 60_000);

  it("is independent of a pause: a paused clinic still stores the command and keeps its pause", async () => {
    writeFileSync(join(home, "state.json"), JSON.stringify({
      lastSyncedVisitDate: "2026-09-10", lastSyncAt: null, batchSequence: 4,
      syncControlState: "PAUSED", appliedControlRevision: 2, pauseReason: "รีเซ็ต",
    }));
    reply = { id: "cmd-p", targetVersion: "9.9.9", assetName: "SDCAgent-Setup-9.9.9.exe", size: 10, sha256: "c".repeat(64) };
    const r = await runner();
    await r.heartbeat("ONLINE");
    expect(JSON.parse(readFileSync(join(home, "update-command.json"), "utf8")).state).toBe("DELIVERED");
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    expect(state.syncControlState).toBe("PAUSED");
    expect(state.batchSequence).toBe(4);
    expect(state.lastSyncedVisitDate).toBe("2026-09-10");
  }, 60_000);

  it("ignores a malformed command rather than crashing the heartbeat", async () => {
    reply = { id: 42, targetVersion: null } as unknown as Record<string, unknown>;
    const r = await runner();
    await expect(r.heartbeat("ONLINE")).resolves.toBeTruthy();
    expect(existsSync(join(home, "update-command.json"))).toBe(false);
  }, 60_000);

  it("what it sends never includes a secret", async () => {
    reply = { id: "cmd-s", targetVersion: "9.9.9", assetName: "SDCAgent-Setup-9.9.9.exe", size: 10, sha256: "c".repeat(64) };
    const r = await runner();
    await r.heartbeat("ONLINE");
    await r.heartbeat("ONLINE");
    for (const b of bodies) {
      const text = JSON.stringify(b);
      expect(text).not.toContain("s".repeat(40));
      expect(text).not.toMatch(/"secret"|"password"|"token"/);
    }
  }, 60_000);
});
