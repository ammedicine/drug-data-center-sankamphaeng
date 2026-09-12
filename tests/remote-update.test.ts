/**
 * "Update now" from the centre, end to end against a real database.
 *
 * The scenarios are the district's: one Agent, a selection of many, a machine
 * that is switched off, a machine that is paused, one that is mid-sync, three
 * older builds that cannot act on a command, a second click, a restart
 * mid-install, and a slot bound so fifteen machines do not all download at
 * once. Everything runs through the real service and the real migrations
 * (0000 - 0011) on MySQL 8.4; the release lookup is the one thing stood in
 * for, because a test must not depend on GitHub.
 *
 * Fails rather than skips when there is no database.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_remote_update";

let available = false;
let setupError: unknown = null;
let c: mysql.Connection;
type Svc = typeof import("@/lib/services/update-commands");
let svc: Svc;

const RELEASE = {
  version: "v1.1.10",
  publishedAt: "2026-09-12T00:00:00Z",
  fileName: "SDCAgent-Setup-1.1.10.exe",
  sizeBytes: 40_500_000,
  assetId: 1,
  notes: null,
  sha256: "a".repeat(64),
};

function requireDatabase() {
  if (!available) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(
      `The remote-update gate needs MySQL on ${SERVER.host}:${SERVER.port} and must never pass without it. Cause: ${detail}`,
    );
  }
}

const caps = (remoteUpdate: boolean) =>
  JSON.stringify({ autoUpdate: true, remotePause: true, syncStartDate: true, charsetGate: true, workerLock: true, boundedWorkerLog: true, remoteUpdate });

beforeAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
    await root.end();

    process.env.DATABASE_URL = `mysql://root@127.0.0.1:3306/${DB}`;
    process.env.DATABASE_CA_FILE = "C:/laragon/data/mysql-8.4/ca.pem";

    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const mig = await mysql.createConnection({ uri: process.env.DATABASE_URL, multipleStatements: true });
    await migrate(drizzle(mig), { migrationsFolder: "./drizzle" });
    await mig.end();

    c = await mysql.createConnection({ ...SERVER, database: DB });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const old = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

    await c.query(
      `INSERT INTO facilities (id, code, name, jhcis_pcucode, is_active, created_at, updated_at)
       VALUES ('fac-a','RPST-05957','กอสะเลียม','05957',1,?,?), ('fac-b','RPST-05954','สันโค้ง','05954',1,?,?)`,
      [now, now, now, now],
    );
    await c.query(
      `INSERT INTO users (id, username, email, full_name, password_hash, role, is_active, facility_id, created_at, updated_at)
       VALUES ('super','super','super@example.test','ผู้ดูแล','x','SUPER_ADMIN',1,NULL,?,?),
              ('facadmin','fa','fa@example.test','หัวหน้า','x','FACILITY_ADMIN',1,'fac-a',?,?),
              ('exsuper','ex','ex@example.test','อดีต','x','SUPER_ADMIN',0,NULL,?,?)`,
      [now, now, now, now, now, now],
    );
    const agent = (id: string, fac: string, name: string, version: string, remote: boolean, hb: string, extra = "") =>
      c.query(
        `INSERT INTO agents (id, facility_id, name, status, version, build_id, capabilities, jhcis_connected,
           last_heartbeat_at, last_seen_at, sync_interval_minutes, reprocess_days, pending_batches, sync_count,
           failed_count, sync_control_state, control_revision, created_at, updated_at${extra ? "," + extra.split("=")[0] : ""})
         VALUES (?,?,?,?,?,?,?,1,?,?,60,7,0,0,0,'RUNNING',0,?,?${extra ? "," + extra.split("=")[1] : ""})`,
        [id, fac, name, "ONLINE", version, version === "1.1.7" ? null : "abc1234", remote ? caps(true) : version === "1.1.7" ? null : caps(false), hb, hb, now, now],
      );
    await agent("a-new", "fac-a", "new-online", "1.1.9", true, now);
    await agent("a-off", "fac-a", "new-offline", "1.1.9", true, old);
    await agent("a-paused", "fac-b", "new-paused", "1.1.9", true, now);
    await c.query(`UPDATE agents SET sync_control_state='PAUSED', control_revision=3 WHERE id='a-paused'`);
    await agent("a-117", "fac-b", "legacy-117", "1.1.7", false, now);
    await agent("a-118", "fac-b", "legacy-118", "1.1.8", false, now);
    await agent("a-119", "fac-b", "legacy-119", "1.1.9", false, now);
    await agent("a-done", "fac-a", "already-1.1.10", "1.1.10", true, now);
    for (let i = 1; i <= 6; i++) await agent(`bulk-${i}`, "fac-b", `bulk-${i}`, "1.1.9", true, now);

    vi.doMock("@/lib/services/agent-release", () => ({
      lookupLatestAgentRelease: async () => ({ status: "ok", release: RELEASE }),
      getLatestAgentRelease: async () => RELEASE,
    }));
    svc = await import("@/lib/services/update-commands");
    available = true;
  } catch (error) {
    console.error("[remote-update gate] setup failed:", error);
    setupError = error;
    available = false;
  }
}, 180_000);

afterAll(async () => {
  try {
    await c?.end();
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.end();
  } catch {
    /* a leftover test schema is not worth failing a run over */
  }
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_CA_FILE;
  vi.doUnmock("@/lib/services/agent-release");
});

const actor = { userId: "super", label: "super@example.test", ip: "203.0.113.1" };

async function commands(agentId: string) {
  const [rows] = await c.query<mysql.RowDataPacket[]>(
    "SELECT id, status, target_version, group_id, attempts, last_error_code FROM agent_update_commands WHERE agent_id=? ORDER BY requested_at",
    [agentId],
  );
  return rows;
}
async function audits(action: string, agentId?: string) {
  const [rows] = await c.query<mysql.RowDataPacket[]>(
    `SELECT actor_type, actor_id, resource_id, metadata FROM audit_logs WHERE action=?${agentId ? " AND resource_id=?" : ""} ORDER BY id`,
    agentId ? [action, agentId] : [action],
  );
  return rows;
}
const heartbeat = (agentId: string, version = "1.1.9", report: Record<string, unknown> | null = null) =>
  (async () => {
    const open = await svc.openCommandsFor(agentId);
    const still = await svc.applyAgentUpdateReport({ agentId, runningVersion: version, report, open });
    return svc.deliverUpdateCommand({ agentId, capabilities: JSON.parse(caps(true)), open: still });
  })();

describe("B. one agent", () => {
  it("a SUPER_ADMIN's click becomes one durable, audited command", async () => {
    requireDatabase();
    const { outcomes, target } = await svc.requestAgentUpdates({ agentIds: ["a-new"], actor });
    expect(target.version).toBe("1.1.10");
    expect(outcomes[0].outcome).toBe("REQUESTED");
    const rows = await commands("a-new");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("REQUESTED");
    expect(rows[0].target_version).toBe("1.1.10");
    const audit = await audits("AGENT_UPDATE_REQUESTED", "a-new");
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe("super");
    expect(JSON.stringify(audit[0].metadata)).not.toMatch(/secret|token|sha256/i);
  });

  it("a second click is a duplicate, not a second command", async () => {
    requireDatabase();
    const { outcomes } = await svc.requestAgentUpdates({ agentIds: ["a-new"], actor });
    expect(outcomes[0].outcome).toBe("DUPLICATE");
    expect(await commands("a-new")).toHaveLength(1);
    expect(await audits("AGENT_UPDATE_REQUESTED", "a-new")).toHaveLength(1);
  });

  it("is refused for anyone who is not an active SUPER_ADMIN, writing nothing", async () => {
    requireDatabase();
    for (const userId of ["facadmin", "exsuper", "nobody"]) {
      await expect(svc.requestAgentUpdates({ agentIds: ["a-off"], actor: { userId } })).rejects.toBeInstanceOf(
        svc.UpdateAuthorizationError,
      );
    }
    expect(await commands("a-off")).toHaveLength(0);
    expect(await audits("AGENT_UPDATE_REQUESTED", "a-off")).toHaveLength(0);
  });

  it("an online agent receives it on the next heartbeat, and DELIVERED is recorded", async () => {
    requireDatabase();
    const delivered = await heartbeat("a-new");
    expect(delivered).toMatchObject({ targetVersion: "1.1.10", assetName: "SDCAgent-Setup-1.1.10.exe", sha256: "a".repeat(64) });
    const [row] = await commands("a-new");
    expect(row.status).toBe("DELIVERED");
    // Handed out again on every heartbeat until closed; the agent dedups by id.
    const again = await heartbeat("a-new");
    expect(again?.id).toBe(delivered?.id);
  });

  it("an offline agent's command simply waits, durably, with nobody re-clicking", async () => {
    requireDatabase();
    const { outcomes } = await svc.requestAgentUpdates({ agentIds: ["a-off"], actor });
    expect(outcomes[0].outcome).toBe("REQUESTED");
    const [row] = await commands("a-off");
    expect(row.status).toBe("REQUESTED");
    // Hours later, it comes on and heartbeats.
    const delivered = await heartbeat("a-off");
    expect(delivered?.targetVersion).toBe("1.1.10");
    expect((await commands("a-off"))[0].status).toBe("DELIVERED");
  });

  it("an agent already on the target is told so and gets no row", async () => {
    requireDatabase();
    const { outcomes } = await svc.requestAgentUpdates({ agentIds: ["a-done"], actor });
    expect(outcomes[0].outcome).toBe("ALREADY_UP_TO_DATE");
    expect(await commands("a-done")).toHaveLength(0);
  });
});

describe("H. legacy clients", () => {
  it("1.1.7, 1.1.8 and 1.1.9 cannot act on a command and are said to be unsupported, not failed", async () => {
    requireDatabase();
    const { outcomes } = await svc.requestAgentUpdates({ agentIds: ["a-117", "a-118", "a-119"], actor });
    for (const o of outcomes) expect(o.outcome, o.agentId).toBe("UNSUPPORTED_CLIENT");
    for (const id of ["a-117", "a-118", "a-119"]) expect(await commands(id)).toHaveLength(0);
    // And nothing is ever offered to them on a heartbeat: 1.1.7 sends no
    // capabilities at all, 1.1.8/1.1.9 send a record without remoteUpdate.
    expect(await svc.deliverUpdateCommand({ agentId: "a-117", capabilities: null })).toBeNull();
    expect(await svc.deliverUpdateCommand({ agentId: "a-118", capabilities: JSON.parse(caps(false)) })).toBeNull();
    expect(await svc.deliverUpdateCommand({ agentId: "a-119", capabilities: JSON.parse(caps(false)) })).toBeNull();
  });
});

describe("D. a paused agent, and the slot bound", () => {
  it("is held back while two others are already updating, then receives the command; the pause is untouched", async () => {
    requireDatabase();
    const { outcomes } = await svc.requestAgentUpdates({ agentIds: ["a-paused"], actor });
    expect(outcomes[0].outcome).toBe("REQUESTED");
    // a-new and a-off both hold a slot (DELIVERED). Fleet-wide bound is two,
    // so this heartbeat is told nothing and the row stays REQUESTED.
    expect(await heartbeat("a-paused")).toBeNull();
    expect((await commands("a-paused"))[0].status).toBe("REQUESTED");
    // a-off's machine reports it is done; one slot frees; the paused agent
    // gets its command on the very next heartbeat.
    await heartbeat("a-off", "1.1.10");
    expect((await commands("a-off"))[0].status).toBe("SUCCESS");
    const delivered = await heartbeat("a-paused");
    expect(delivered?.targetVersion).toBe("1.1.10");
    const [[agent]] = await c.query<mysql.RowDataPacket[]>("SELECT sync_control_state FROM agents WHERE id='a-paused'");
    expect(agent.sync_control_state).toBe("PAUSED"); // the pause is about data, not software
  });
});

describe("E./G. progress, waiting, and a restart mid-install", () => {
  it("moves along the table as the agent reports, and never backwards", async () => {
    requireDatabase();
    const id = (await commands("a-new"))[0].id;
    for (const state of ["CHECKING", "DOWNLOADING", "WAITING_FOR_IDLE", "DOWNLOADING", "VERIFYING", "INSTALLING"]) {
      await heartbeat("a-new", "1.1.9", { commandId: id, state });
      expect((await commands("a-new"))[0].status, state).toBe(state);
    }
    // A stale, out-of-order report is ignored.
    await heartbeat("a-new", "1.1.9", { commandId: id, state: "CHECKING" });
    expect((await commands("a-new"))[0].status).toBe("INSTALLING");
    expect((await commands("a-new"))[0].attempts).toBe(1);
  });

  it("closes as SUCCESS from the version alone when the installer restarted the agent", async () => {
    requireDatabase();
    // The new build heartbeats with no report yet (it has not read its file),
    // but it is running the target.
    await heartbeat("a-new", "1.1.10", null);
    const [row] = await commands("a-new");
    expect(row.status).toBe("SUCCESS");
    const done = await audits("AGENT_UPDATE_COMPLETED", "a-new");
    expect(done).toHaveLength(1);
    expect(done[0].actor_type).toBe("AGENT");
    // Nothing more is handed out.
    expect(await heartbeat("a-new", "1.1.10")).toBeNull();
  });

  it("records a failure with its code, once, and hands nothing further out", async () => {
    requireDatabase();
    const id = (await commands("a-paused"))[0].id;
    await heartbeat("a-paused", "1.1.9", { commandId: id, state: "FAILED", errorCode: "DIGEST_MISMATCH", errorMessage: "ค่าตรวจสอบไม่ตรง" });
    const [row] = await commands("a-paused");
    expect(row.status).toBe("FAILED");
    expect(row.last_error_code).toBe("DIGEST_MISMATCH");
    expect(await audits("AGENT_UPDATE_FAILED", "a-paused")).toHaveLength(1);
    expect(await heartbeat("a-paused")).toBeNull();
    // The snapshot on the agent row says so too, for the screen.
    const [[agent]] = await c.query<mysql.RowDataPacket[]>("SELECT update_state, update_error_code FROM agents WHERE id='a-paused'");
    expect(agent.update_state).toBe("FAILED");
    expect(agent.update_error_code).toBe("DIGEST_MISMATCH");
  });

  it("times out a command nobody finished, so INSTALLING is never for ever", async () => {
    requireDatabase();
    // A fresh command for a-off, deliberately left at INSTALLING for 30 hours.
    await c.query("UPDATE agents SET version='1.1.9' WHERE id='a-off'");
    const { outcomes } = await svc.requestAgentUpdates({ agentIds: ["a-off"], actor });
    expect(outcomes[0].outcome).toBe("REQUESTED");
    const row = (await commands("a-off")).find((r) => r.status === "REQUESTED")!;
    await c.query("UPDATE agent_update_commands SET status='INSTALLING', status_changed_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 HOUR) WHERE id=?", [row.id]);
    await heartbeat("a-off");
    const after = (await commands("a-off")).find((r) => r.id === row.id)!;
    expect(after.status).toBe("FAILED");
    expect(after.last_error_code).toBe("UPDATE_TIMED_OUT");
  });
});

describe("C. a selection of many", () => {
  it("creates one independent command per agent, sharing a group id", async () => {
    requireDatabase();
    const ids = Array.from({ length: 6 }, (_, i) => `bulk-${i + 1}`);
    const { groupId, outcomes } = await svc.requestAgentUpdates({ agentIds: ids, actor });
    expect(outcomes.filter((o) => o.outcome === "REQUESTED")).toHaveLength(6);
    for (const id of ids) {
      const rows = await commands(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].group_id).toBe(groupId);
      expect(await audits("AGENT_UPDATE_REQUESTED", id)).toHaveLength(1);
    }
  });

  it("hands out at most two at a time, and the rest as slots free up", async () => {
    requireDatabase();
    const ids = Array.from({ length: 6 }, (_, i) => `bulk-${i + 1}`);
    const first = await Promise.all(ids.map((id) => heartbeat(id)));
    const delivered = first.filter(Boolean).length;
    // Six machines heartbeat together; two get the command, four are told
    // nothing and their rows stay REQUESTED for the next heartbeat.
    expect(delivered).toBe(2);
    const [[active]] = await c.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) n FROM agent_update_commands WHERE agent_id LIKE 'bulk-%' AND status='DELIVERED'",
    );
    expect(Number(active.n)).toBe(2);

    // One of the two finishes; one more slot opens; exactly one more is handed out.
    const winner = ids.find((_, i) => first[i])!;
    await heartbeat(winner, "1.1.10");
    const second = await Promise.all(ids.map((id) => heartbeat(id)));
    const [[activeNow]] = await c.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) n FROM agent_update_commands WHERE agent_id LIKE 'bulk-%' AND status IN ('DELIVERED')",
    );
    expect(Number(activeNow.n)).toBe(2);
    expect(second.filter(Boolean).length).toBe(2); // the one still active + the newly promoted
  });

  it("one agent's failure does not touch the others", async () => {
    requireDatabase();
    const [[row]] = await c.query<mysql.RowDataPacket[]>(
      "SELECT id, agent_id FROM agent_update_commands WHERE agent_id LIKE 'bulk-%' AND status='DELIVERED' LIMIT 1",
    );
    await heartbeat(row.agent_id, "1.1.9", { commandId: row.id, state: "FAILED", errorCode: "INSTALLER_FAILED", errorMessage: "exit 5" });
    const [[counts]] = await c.query<mysql.RowDataPacket[]>(
      "SELECT SUM(status='FAILED') failed, SUM(status='SUCCESS') ok, SUM(status IN ('REQUESTED','DELIVERED')) open FROM agent_update_commands WHERE agent_id LIKE 'bulk-%'",
    );
    expect(Number(counts.failed)).toBe(1);
    expect(Number(counts.ok)).toBe(1);
    expect(Number(counts.open)).toBe(4);
  });

  it("an operator can withdraw a command nobody has picked up yet, and only that", async () => {
    requireDatabase();
    const [[pending]] = await c.query<mysql.RowDataPacket[]>(
      "SELECT id FROM agent_update_commands WHERE agent_id LIKE 'bulk-%' AND status='REQUESTED' LIMIT 1",
    );
    const [[delivered]] = await c.query<mysql.RowDataPacket[]>(
      "SELECT id FROM agent_update_commands WHERE agent_id LIKE 'bulk-%' AND status='DELIVERED' LIMIT 1",
    );
    expect(await svc.cancelUpdateCommand({ commandId: pending.id, actor })).toBe(true);
    expect(await svc.cancelUpdateCommand({ commandId: delivered.id, actor })).toBe(false);
    expect(await audits("AGENT_UPDATE_CANCELLED")).toHaveLength(1);
  });
});

describe("F. what the browser cannot do", () => {
  it("cannot choose the installer: the target is pinned server-side to the published release", async () => {
    requireDatabase();
    const [[row]] = await c.query<mysql.RowDataPacket[]>(
      "SELECT target_asset_name, target_sha256, target_size FROM agent_update_commands LIMIT 1",
    );
    expect(row.target_asset_name).toBe(RELEASE.fileName);
    expect(row.target_sha256).toBe(RELEASE.sha256);
    expect(Number(row.target_size)).toBe(RELEASE.sizeBytes);
    // requestAgentUpdates takes agent ids and an actor - nothing else.
    const source = (await import("node:fs")).readFileSync("src/lib/services/update-commands.ts", "utf8");
    expect(source).not.toMatch(/downloadUrl\s*[:=]\s*input/);
    expect(source).not.toMatch(/targetVersion\s*[:=]\s*input\./);
  });
});
