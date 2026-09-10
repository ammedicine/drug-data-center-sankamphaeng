/**
 * Repairing a watermark that has run ahead of real time, on both sides.
 *
 * The agent half is straightforward: it clamps what it writes and repairs what
 * it holds before planning a run.
 *
 * The centre is the hard half, and the reason this file exists. An agent only
 * moves the authoritative watermark by completing a batch, and an agent with
 * nothing new to send opens no batch - deliberately, because opening one every
 * cycle is how the audit history filled with 115 empty rows out of 136. So a
 * quiet สถานบริการ carrying a future watermark could never repair it: it would
 * collect nothing, therefore send nothing, therefore never correct the value
 * that was stopping it. Production 05957 is in precisely that state, on
 * v1.1.7, which cannot be taught anything new.
 *
 * The centre therefore repairs it itself, on the heartbeat - the one request
 * every agent makes whatever version it runs.
 *
 * Runs against a real database with the real migrations, and fails rather than
 * skips when there is none.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_watermark_norm";

let available = false;
let setupError: unknown = null;
let c: mysql.Connection;

function requireDatabase() {
  if (!available) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(
      `The watermark gate needs MySQL on ${SERVER.host}:${SERVER.port} and must never pass ` +
        `without it. Cause: ${detail}`,
    );
  }
}

/** The exact expression the heartbeat route applies. */
const NORMALISE = `UPDATE agents SET last_synced_visit_date =
  CASE WHEN last_synced_visit_date > UTC_DATE() THEN UTC_DATE() ELSE last_synced_visit_date END
  WHERE id = ?`;

/** The exact expression completeBatch applies. */
const COMPLETE = `UPDATE agents SET last_synced_visit_date =
  LEAST(GREATEST(COALESCE(last_synced_visit_date, '1900-01-01'), ?), UTC_DATE()) WHERE id = ?`;

async function watermarkOf(id: string): Promise<string | null> {
  const [rows] = await c.query<mysql.RowDataPacket[]>(
    "SELECT DATE_FORMAT(last_synced_visit_date, '%Y-%m-%d') d FROM agents WHERE id = ?",
    [id],
  );
  return rows[0]?.d ?? null;
}

async function setWatermark(id: string, value: string | null) {
  await c.query("UPDATE agents SET last_synced_visit_date = ? WHERE id = ?", [value, id]);
}

async function today(): Promise<string> {
  const [rows] = await c.query<mysql.RowDataPacket[]>("SELECT DATE_FORMAT(UTC_DATE(),'%Y-%m-%d') d");
  return String(rows[0].d);
}

/** A date well beyond any plausible eligible day. */
async function future(days = 20): Promise<string> {
  const [rows] = await c.query<mysql.RowDataPacket[]>(
    "SELECT DATE_FORMAT(DATE_ADD(UTC_DATE(), INTERVAL ? DAY),'%Y-%m-%d') d",
    [days],
  );
  return String(rows[0].d);
}

beforeAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
    await root.end();

    const url = `mysql://root@127.0.0.1:3306/${DB}`;
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const mig = await mysql.createConnection({ uri: url, multipleStatements: true });
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
    console.error("[watermark gate] setup failed:", error);
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
});

describe("the centre repairs itself with no new data at all", () => {
  it("lowers a future watermark on an ordinary heartbeat", async () => {
    requireDatabase();
    // Production 05957 exactly: nothing new to send, so no batch will ever be
    // opened, and the value that is stopping collection sits there for ever
    // unless the centre corrects it unprompted.
    const ahead = await future(20);
    await setWatermark("agent-1", ahead);
    expect(await watermarkOf("agent-1")).toBe(ahead);

    await c.query(NORMALISE, ["agent-1"]);

    const now = await today();
    expect(await watermarkOf("agent-1")).toBe(now);
    expect((await watermarkOf("agent-1"))! <= now).toBe(true);
  });

  it("is idempotent, so repeating heartbeats change nothing", async () => {
    requireDatabase();
    const now = await today();
    await setWatermark("agent-1", now);
    for (let i = 0; i < 3; i++) await c.query(NORMALISE, ["agent-1"]);
    expect(await watermarkOf("agent-1")).toBe(now);
  });

  it("leaves an honest past watermark exactly where it is", async () => {
    requireDatabase();
    await setWatermark("agent-1", "2024-03-31");
    await c.query(NORMALISE, ["agent-1"]);
    expect(await watermarkOf("agent-1")).toBe("2024-03-31");
  });

  it("never invents a value where a purge left NULL", async () => {
    requireDatabase();
    // The reset contract: NULL means "recollect from syncStartDate". LEAST
    // would have turned this into today and silently cancelled a purge.
    await setWatermark("agent-1", null);
    await c.query(NORMALISE, ["agent-1"]);
    expect(await watermarkOf("agent-1")).toBeNull();
  });
});

describe("completing a batch cannot push it into the future either", () => {
  it("clamps an agent that reports a month-end that has not happened", async () => {
    requireDatabase();
    const now = await today();
    await setWatermark("agent-1", "2024-01-01");
    // An agent repairing the current month reports its month end.
    await c.query(COMPLETE, [await future(20), "agent-1"]);
    expect(await watermarkOf("agent-1")).toBe(now);
  });

  it("still refuses to go backwards on an old back-fill", async () => {
    requireDatabase();
    // The property GREATEST was there for: re-reading one week in July must
    // not drag the watermark back and re-collect the autumn.
    await setWatermark("agent-1", "2026-06-30");
    await c.query(COMPLETE, ["2024-07-07", "agent-1"]);
    expect(await watermarkOf("agent-1")).toBe("2026-06-30");
  });
});

describe("every combination of local and central state", () => {
  /**
   * The agent-side rules, evaluated exactly as the agent evaluates them:
   * a stored value is clamped to today before use, and the centre is followed
   * only when it is behind.
   */
  function effective(localRaw: string | null, centralRaw: string | null, now: string) {
    const clamp = (v: string | null) => (v && v > now ? now : v);
    const local = clamp(localRaw);
    const central = clamp(centralRaw);
    // adoptCentralWatermark: follow the centre only when it is behind.
    if (local === central) return local;
    if (central !== null && (local === null || central >= local)) return local;
    return central;
  }

  it("never skips a legitimate row, in any of the seven cases", async () => {
    requireDatabase();
    const now = await today();
    const ahead = await future(20);
    const floor = "2022-10-01";

    const cases: Array<[string, string | null, string | null]> = [
      ["local future / central valid", ahead, "2026-09-01"],
      ["local valid / central future", "2026-09-01", ahead],
      ["both future", ahead, ahead],
      ["central NULL / local future", ahead, null],
      ["local NULL / central future", null, ahead],
      ["both valid", "2026-09-01", "2026-09-01"],
      ["central NULL after a purge / local current", now, null],
    ];

    for (const [label, local, central] of cases) {
      const result = effective(local, central, now);
      if (result === null) {
        // NULL is the deliberate reset signal: recollect from the floor. It is
        // the one case where "no watermark" is the correct answer.
        expect(["central NULL / local future", "local NULL / central future",
          "central NULL after a purge / local current"], label).toContain(label);
        continue;
      }
      // The invariant: within the floor, and never claiming a day that has
      // not happened.
      expect(result >= floor, `${label}: ${result} is below the floor`).toBe(true);
      expect(result <= now, `${label}: ${result} is in the future`).toBe(true);
    }
  });
});
