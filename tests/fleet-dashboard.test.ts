/**
 * The screen an operator looks at before clearing the centre's data.
 *
 * Run against a real MySQL with the real migrations, because the thing most
 * likely to break this page is not its logic but a column that was added to
 * the schema and never to the database. That failure mode is not hypothetical:
 * the first time listFleet was pointed at a live database it failed on
 * `Unknown column 'agents.paused_by_user_id'`, which is exactly the class of
 * problem a mocked test would have sailed past.
 *
 * The fixture deliberately contains the awkward cases rather than a tidy
 * fleet: two Agents at one สถานบริการ, a machine that has been switched off,
 * one on a build that has never heard of pausing, and a stale UPLOADING batch
 * left behind by a worker that was killed.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_fleet_ui";

let available = false;
let setupError: unknown = null;
let fleet: typeof import("@/lib/services/fleet");

/**
 * Fails loudly rather than skipping.
 *
 * A release gate that quietly passes because nobody started MySQL is not a
 * gate. The suite says so and fails; a developer without a local database can
 * see precisely what to start.
 */
function requireDatabase() {
  if (!available) {
    // The underlying error is carried through rather than replaced by a guess.
    // "Not reachable" would have been wrong the first time this ran: MySQL was
    // up, and the fixture had a bad column name.
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(
      `The fleet gate needs MySQL on ${SERVER.host}:${SERVER.port} and a working fixture, ` +
        `and did not get one. This test must never pass without a database. Cause: ${detail}`,
    );
  }
}

beforeAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
    await root.end();

    process.env.DATABASE_URL = `mysql://root@127.0.0.1:3306/${DB}`;
    // MySQL 8.4 turns TLS on with a CA it generates itself. The production
    // pool verifies certificates and is not going to stop doing that for a
    // test, so the test trusts that CA instead - the connection is still
    // verified, against a different root.
    process.env.DATABASE_CA_FILE = "C:/laragon/data/mysql-8.4/ca.pem";

    // The real migrations, in order, including 0010 - so a column that exists
    // only in schema.ts is caught here rather than in production.
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const connection = await mysql.createConnection({
      uri: process.env.DATABASE_URL,
      multipleStatements: true,
    });
    await migrate(drizzle(connection), { migrationsFolder: "./drizzle" });
    await connection.end();

    const c = await mysql.createConnection({ ...SERVER, database: DB });
    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const fresh = iso(now);
    const longAgo = iso(new Date(now.getTime() - 6 * 60 * 60 * 1000));

    await c.query(
      `INSERT INTO facilities (id, code, name, jhcis_pcucode, is_active, created_at, updated_at)
       VALUES ('fac-a','RPST-05957','รพ.สต.บ้านกอสะเลียม','05957',1,?,?),
              ('fac-b','RPST-05954','รพ.สต.บ้านสันโค้ง','05954',1,?,?)`,
      [fresh, fresh, fresh, fresh],
    );
    await c.query(
      `INSERT INTO users (id, username, email, full_name, password_hash, role, is_active, created_at, updated_at)
       VALUES ('user-1','admin','admin@example.test','ผู้ดูแลระบบ','x','SUPER_ADMIN',1,?,?)`,
      [fresh, fresh],
    );

    // A healthy agent, running.
    await c.query(
      `INSERT INTO agents (id, facility_id, name, status, version, build_id, capabilities,
         jhcis_pcucode, jhcis_connected, last_heartbeat_at, last_seen_at, sync_interval_minutes,
         reprocess_days, pending_batches, sync_count, failed_count, sync_control_state,
         control_revision, sync_start_date, created_at, updated_at)
       VALUES ('agent-run','fac-a','chaiya','ONLINE','1.1.8','02eec74',
         '{"remotePause":true,"syncStartDate":true,"autoUpdate":true}','05957',1,?,?,60,7,0,5,0,
         'RUNNING',0,'2022-10-01',?,?)`,
      [fresh, fresh, fresh, fresh],
    );

    // A second agent at the SAME สถานบริการ, paused and acknowledged.
    await c.query(
      `INSERT INTO agents (id, facility_id, name, status, version, build_id, capabilities,
         jhcis_pcucode, jhcis_connected, last_heartbeat_at, last_seen_at, sync_interval_minutes,
         reprocess_days, pending_batches, sync_count, failed_count, sync_control_state,
         control_revision, applied_control_revision, effective_sync_state, paused_at,
         paused_by_user_id, pause_reason, sync_start_date, created_at, updated_at)
       VALUES ('agent-paused','fac-a','สำรอง','ONLINE','1.1.8','02eec74',
         '{"remotePause":true,"syncStartDate":true}','05957',1,?,?,60,7,0,2,0,
         'PAUSED',3,3,'PAUSED',?,'user-1','เตรียมล้างข้อมูล','2022-10-01',?,?)`,
      [fresh, fresh, fresh, fresh, fresh],
    );

    // An old build: paused at the centre, will never acknowledge, and switched
    // off six hours ago. The case the whole barrier exists for.
    await c.query(
      `INSERT INTO agents (id, facility_id, name, status, version, jhcis_pcucode, jhcis_connected,
         last_heartbeat_at, last_seen_at, sync_interval_minutes, reprocess_days, pending_batches,
         sync_count, failed_count, sync_control_state, control_revision, created_at, updated_at)
       VALUES ('agent-old','fac-b','05954-ชุตติภัทร','ONLINE','1.1.7','05954',1,?,?,60,7,0,9,0,
         'PAUSED',1,?,?)`,
      [longAgo, longAgo, fresh, fresh],
    );

    // A stale UPLOADING batch from a worker that was killed hours ago. It must
    // stay in history and never be drawn as current work.
    await c.query(
      `INSERT INTO sync_batches (id, batch_ref, agent_id, facility_id, mode, status, range_from,
         range_to, started_at, records_read, records_sent, records_accepted, records_rejected,
         created_at, updated_at)
       VALUES ('batch-stale','SYNC-STALE','agent-run','fac-a','INCREMENTAL','UPLOADING',
         '2024-01-01','2024-01-31',?,100,0,0,0,?,?)`,
      [longAgo, longAgo, longAgo],
    );
    await c.end();

    fleet = await import("@/lib/services/fleet");
    available = true;
  } catch (error) {
    // Recorded, then re-thrown by requireDatabase in each test, so the reason
    // is visible instead of a silent green run.
    console.error("[fleet gate] setup failed:", error);
    setupError = error;
    available = false;
  }
}, 180_000);

afterAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.end();
  } catch {
    /* leaving a test schema behind is not worth failing a run over */
  }
  delete process.env.DATABASE_URL;
});

describe("the fleet as the centre sees it", () => {
  it("returns one row per agent, not per facility", async () => {
    requireDatabase();
    const rows = await fleet.listFleet();
    expect(rows).toHaveLength(3);
    // Two of them share a สถานบริการ. Collapsing those would let somebody
    // pause a machine they could not see on the screen.
    const atA = rows.filter((r) => r.facilityCode === "RPST-05957");
    expect(atA).toHaveLength(2);
    expect(new Set(atA.map((r) => r.agentId)).size).toBe(2);
  });

  it("keeps the centre's decision and the agent's answer apart", async () => {
    requireDatabase();
    const rows = await fleet.listFleet();
    const paused = rows.find((r) => r.agentId === "agent-paused")!;
    const old = rows.find((r) => r.agentId === "agent-old")!;

    // Acknowledged.
    expect(paused.desiredSyncState).toBe("PAUSED");
    expect(paused.ingestAllowed).toBe(false);
    expect(paused.ack).toBe("IN_SYNC");
    expect(paused.pausedByName).toBe("ผู้ดูแลระบบ");
    expect(paused.pauseReason).toBe("เตรียมล้างข้อมูล");

    // Never will acknowledge - and is still blocked, which is the point.
    expect(old.desiredSyncState).toBe("PAUSED");
    expect(old.ingestAllowed).toBe(false);
    expect(old.ack).toBe("UNSUPPORTED");
    expect(old.capabilities.remotePause).toBe(false);
  });

  it("does not call a paused agent offline", async () => {
    requireDatabase();
    const rows = await fleet.listFleet();
    const paused = rows.find((r) => r.agentId === "agent-paused")!;
    // It is heartbeating. Saying OFFLINE would send somebody to a clinic to
    // fix a machine that is working.
    expect(paused.status).not.toBe("OFFLINE");
    const summary = fleet.summariseFleet(rows);
    expect(summary.paused).toBe(2);
    expect(summary.ingestBlocked).toBe(2);
    // The switched-off one is offline on its own merits, not because of pause.
    expect(summary.offline).toBe(1);
    expect(summary.total).toBe(3);
  });

  it("never shows a stale UPLOADING batch as current work", async () => {
    requireDatabase();
    const rows = await fleet.listFleet();
    // The batch is six hours old and its worker is gone. It belongs in
    // history, and drawing it as a live progress bar would have an operator
    // waiting for a run that ended long ago.
    expect(rows.every((r) => r.current === null)).toBe(true);
    expect(fleet.summariseFleet(rows).syncing).toBe(0);
  });
});

describe("reset readiness", () => {
  it("separates what the centre guarantees from what an agent has confirmed", async () => {
    requireDatabase();
    const rows = await fleet.listFleet();
    const readiness = fleet.resetReadiness(rows);

    const old = readiness.find((r) => r.agentId === "agent-old")!;
    // The case that must not be reported as a blocker: an old, offline agent
    // that will never acknowledge, and cannot write to Central either way.
    expect(old.centralBlocked).toBe(true);
    expect(old.ack).toBe("UNSUPPORTED");
    expect(old.safeToReset).toBe(true);
    expect(old.blocker).toBeNull();

    // And the one still running is the genuine blocker.
    const running = readiness.find((r) => r.agentId === "agent-run")!;
    expect(running.centralBlocked).toBe(false);
    expect(running.safeToReset).toBe(false);
    expect(running.blocker).toContain("ยังไม่ได้หยุด");
  });
});

describe("changing what the centre has decided", () => {
  it("bumps a revision so an agent obeys once, and is idempotent", async () => {
    requireDatabase();
    const first = await fleet.setAgentSyncControl({
      agentId: "agent-run",
      desired: "PAUSED",
      actorUserId: "user-1",
      reason: "ทดสอบ",
    });
    expect(first.changed).toBe(true);
    expect(first.revision).toBe(1);

    // Pausing something already paused is not a new instruction.
    const again = await fleet.setAgentSyncControl({
      agentId: "agent-run",
      desired: "PAUSED",
      actorUserId: "user-1",
      reason: "ทดสอบ",
    });
    expect(again.changed).toBe(false);
    expect(again.revision).toBe(1);

    const rows = await fleet.listFleet();
    expect(rows.find((r) => r.agentId === "agent-run")!.ingestAllowed).toBe(false);

    // Resuming clears the reason and who paused it, rather than leaving a
    // stale explanation on a running agent.
    const resumed = await fleet.setAgentSyncControl({
      agentId: "agent-run",
      desired: "RUNNING",
      actorUserId: "user-1",
    });
    expect(resumed.changed).toBe(true);
    expect(resumed.revision).toBe(2);
    const after = (await fleet.listFleet()).find((r) => r.agentId === "agent-run")!;
    expect(after.pauseReason).toBeNull();
    expect(after.pausedAt).toBeNull();
    expect(after.ingestAllowed).toBe(true);
  });

  it("resolves a bulk selection from the database, not from the browser", async () => {
    requireDatabase();
    // "All" must mean every agent the database knows about. A stale page that
    // was rendered before a สถานบริการ enrolled would otherwise miss exactly
    // the machine that could refill Central.
    const all = await fleet.resolveAgentIds({ all: true });
    expect(all.sort()).toEqual(["agent-old", "agent-paused", "agent-run"]);

    // A facility-wide selection is explicit, and picks up both agents there.
    const byFacility = await fleet.resolveAgentIds({ facilityIds: ["fac-a"] });
    expect(byFacility.sort()).toEqual(["agent-paused", "agent-run"]);
  });
});
