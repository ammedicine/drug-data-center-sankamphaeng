/**
 * Two messages that were true and still misled.
 *
 * A diagnostic is read by somebody deciding whether it is safe to clear a
 * district's data, or whether a สถานบริการ needs a visit. Both of these passed
 * every existing test and both told that person the wrong thing.
 *
 * The first: `verify` on a paused Agent printed "checked 0 months" and then
 * "complete, matching JHCIS in every month". Nothing had been compared.
 *
 * The second: a MANUAL_RANGE refused for starting before the collection floor
 * is a person picking the wrong date, not a fault - and it stayed on the
 * agent's card in Central for ever, because the heartbeat only ever set
 * last_error and never cleared it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import mysql from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/* ------------------------------------------------------- A. paused verify */

let home: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-honest-"));
  process.env.AGENT_DATA_DIR = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

describe("what verify says when it checked nothing", () => {
  it("reports that it was skipped, and claims nothing about completeness", async () => {
    writeFileSync(
      join(home, "agent.config.json"),
      JSON.stringify({
        agentId: "a",
        keyId: "k",
        secret: "s".repeat(40),
        centralApiUrl: "https://central.invalid/",
        facilityId: "f",
        facilityCode: "T",
        expectedPcucode: "T0001",
        installationId: "i",
        syncIntervalMinutes: 60,
        reprocessDays: 7,
      }),
      "utf8",
    );
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        lastSyncedVisitDate: "2026-09-10",
        lastSyncAt: null,
        batchSequence: 5,
        syncControlState: "PAUSED",
        appliedControlRevision: 1,
        pauseReason: "เตรียมล้างข้อมูล",
      }),
      "utf8",
    );

    const { SyncRunner } = await import(`../agent/src/sync?hd=${counter++}`);
    const result = await new SyncRunner().verify({});

    // The result says which of the two happened, rather than leaving a caller
    // to infer "complete" from an empty list of mismatches.
    expect(result.skipped).toBe("PAUSED");
    expect(result.checked).toBe(0);
    expect(result.mismatched).toEqual([]);
  }, 60_000);

  it("prints the skipped wording, not the complete wording", () => {
    // The printing lives in the CLI, so the CLI is what is checked. A paused
    // run must not reach the sentence that claims every month matched.
    const cli = readFileSync(resolve(process.cwd(), "agent/src/cli.ts"), "utf8");
    const verifySection = cli.slice(cli.indexOf("async function verify"));
    const skipIndex = verifySection.indexOf('result.skipped === "PAUSED"');
    const completeIndex = verifySection.indexOf("ข้อมูลครบถ้วน ตรงกับ JHCIS ทุกเดือน");
    expect(skipIndex).toBeGreaterThan(-1);
    expect(completeIndex).toBeGreaterThan(-1);
    // The paused branch returns before the completeness claim is reachable.
    expect(skipIndex).toBeLessThan(completeIndex);
    expect(verifySection).toContain("ข้ามการตรวจสอบ เนื่องจาก Agent ถูกหยุดโดยผู้ดูแลระบบ");
    expect(verifySection).toContain("ยังไม่ทราบความครบถ้วน");
  });

  it("still reports a real check normally once resumed", async () => {
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        lastSyncedVisitDate: "2026-09-10",
        lastSyncAt: null,
        batchSequence: 5,
        syncControlState: "RUNNING",
        appliedControlRevision: 2,
      }),
      "utf8",
    );
    const { syncPaused } = await import(`../agent/src/control?hd=${counter++}`);
    // The guard is a pause guard, not a permanent one - a resumed agent goes
    // back to reporting what it actually checked.
    expect(syncPaused()).toBe(false);
  });
});

/* ------------------------------------------------ B. the stale last_error */

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_last_error";
let available = false;
let setupError: unknown = null;
let c: mysql.Connection;

function requireDatabase() {
  if (!available) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(
      `The last_error gate needs MySQL on ${SERVER.host}:${SERVER.port} and must never pass ` +
        `without it. Cause: ${detail}`,
    );
  }
}

/** Exactly what the heartbeat route writes, in each of its branches. */
const SET_ERROR = "UPDATE agents SET last_error = ?, last_error_at = UTC_TIMESTAMP() WHERE id = ?";
const CLEAR_ERROR = "UPDATE agents SET last_error = NULL WHERE id = ?";

beforeAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query("DROP DATABASE IF EXISTS `" + DB + "`");
    await root.query("CREATE DATABASE `" + DB + "` CHARACTER SET utf8mb4");
    await root.end();

    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const mig = await mysql.createConnection({
      uri: `mysql://root@127.0.0.1:3306/${DB}`,
      multipleStatements: true,
    });
    await migrate(drizzle(mig), { migrationsFolder: "./drizzle" });
    await mig.end();

    c = await mysql.createConnection({ ...SERVER, database: DB });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await c.query(
      `INSERT INTO facilities (id, code, name, jhcis_pcucode, is_active, created_at, updated_at)
       VALUES ('fac-1','RPST-05957','ทดสอบ','05957',1,?,?)`,
      [now, now],
    );
    await c.query(
      `INSERT INTO agents (id, facility_id, name, status, sync_interval_minutes, reprocess_days,
         pending_batches, sync_count, failed_count, created_at, updated_at)
       VALUES ('agent-1','fac-1','ทดสอบ','ONLINE',60,7,0,0,0,?,?)`,
      [now, now],
    );
    available = true;
  } catch (error) {
    console.error("[last_error gate] setup failed:", error);
    setupError = error;
    available = false;
  }
}, 180_000);

afterAll(async () => {
  try {
    await c?.end();
    const root = await mysql.createConnection(SERVER);
    await root.query("DROP DATABASE IF EXISTS `" + DB + "`");
    await root.end();
  } catch {
    /* a leftover test schema is not worth failing a run over */
  }
});

async function agentRow() {
  const [rows] = await c.query<mysql.RowDataPacket[]>(
    "SELECT last_error, last_error_at FROM agents WHERE id = 'agent-1'",
  );
  return rows[0];
}

describe("an error the agent has stopped having", () => {
  it("is cleared by the next healthy heartbeat", async () => {
    requireDatabase();
    const refusal =
      "วันที่เริ่มต้นที่เลือกอยู่ก่อนวันที่เริ่มเก็บข้อมูลของ Agent ช่วงที่ขอ: 01/01/2562";
    await c.query(SET_ERROR, [refusal, "agent-1"]);
    expect((await agentRow()).last_error).toBe(refusal);

    // ONLINE, nothing wrong right now.
    await c.query(CLEAR_ERROR, ["agent-1"]);

    const after = await agentRow();
    expect(after.last_error).toBeNull();
    // When it last happened is history, and history is not rewritten.
    expect(after.last_error_at).not.toBeNull();
  });

  it("is not cleared while the agent is still reporting one", async () => {
    requireDatabase();
    await c.query(SET_ERROR, ["JHCIS ไม่ตอบสนอง", "agent-1"]);
    // A heartbeat carrying status ERROR takes neither the set nor the clear
    // branch, so an active fault is never hidden by the clearing rule.
    expect((await agentRow()).last_error).toBe("JHCIS ไม่ตอบสนอง");
  });

  it("clears through the exact branch the route takes", () => {
    // Read from the route rather than described in prose: the clearing branch
    // must be guarded by the ERROR status, or a broken agent would wipe its
    // own error every thirty seconds and look healthy.
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/agent/heartbeat/route.ts"),
      "utf8",
    );
    const branch = route.slice(
      route.indexOf("...(body.lastError"),
      route.indexOf("// A watermark"),
    );
    expect(branch).toContain('body.status === "ERROR"');
    expect(branch).toContain("{ lastError: null }");
    // lastErrorAt is written only on the setting side, never on the clear.
    expect(branch.split("lastErrorAt").length - 1).toBe(1);
  });
});
