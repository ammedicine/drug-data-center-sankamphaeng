/**
 * A month is complete when every source row is accounted for.
 *
 * February 2024 at the reference สถานบริการ holds two dispensing rows and one
 * of them has an empty drugcode, so the centre stores one and refuses the
 * other - permanently, by design, with the reason recorded. Reconciliation
 * compared JHCIS's count against the centre's accepted count, saw 2 against 1,
 * and concluded the month was short. It then repaired it, checked again, saw 2
 * against 1, and did the same thing on the next schedule, and the next: an
 * hourly loop that also pinned the agent's watermark to February 2024 so it
 * never reached the present.
 *
 * These tests use a real MySQL database shaped like JHCIS, because the fix
 * lives half in SQL, and a fake reader would prove nothing about it. They skip
 * when no local MySQL is available.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ELIGIBLE_SOURCE_ROW_SQL,
  INELIGIBLE_SOURCE_ROW_SQL,
  isIneligibleSourceRow,
} from "@/lib/shared/ingest-rules";

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_test_reconcile";
const PCUCODE = "T9001";

let available = false;
let workDir: string;
let server: Server;
let baseUrl = "";

/** What the mock centre was asked to do, in order. */
const calls = {
  starts: [] as Array<{ batchRef: string; from: string; to: string; recordsRead: number }>,
  completes: [] as Array<{ batchRef: string; status: string; lastVisitDate: string | null }>,
  uploads: 0,
  auditMonths: [] as Array<{ month: string; rows: number }>,
};

async function buildSource() {
  const root = await mysql.createConnection(SERVER);
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4`);
  await root.end();

  const c = await mysql.createConnection({ ...SERVER, database: DB });
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS office (offid VARCHAR(9) PRIMARY KEY, offname VARCHAR(200))`,
    `CREATE TABLE IF NOT EXISTS chospital (hoscode VARCHAR(9) PRIMARY KEY, hosname VARCHAR(200))`,
    `CREATE TABLE IF NOT EXISTS cdrugunitsell (unitsellcode VARCHAR(15) PRIMARY KEY, unitsellname VARCHAR(100))`,
    `CREATE TABLE IF NOT EXISTS cdrug (drugcode CHAR(24) PRIMARY KEY, drugname VARCHAR(255),
       drugnamethai VARCHAR(255), druggenericname VARCHAR(220), drugtype CHAR(2), drugtypesub CHAR(2),
       drugflag CHAR(1), unitsell VARCHAR(15), unitusage VARCHAR(15))`,
    `CREATE TABLE IF NOT EXISTS visit (pcucode CHAR(5), visitno INT, visitdate DATE, dateupdate DATETIME,
       PRIMARY KEY (pcucode, visitno), KEY vs_date (visitdate, visitno))`,
    `CREATE TABLE IF NOT EXISTS visitdrug (pcucode CHAR(5), visitno INT, drugcode CHAR(24), unit INT,
       dose VARCHAR(100), clinic CHAR(5), dateupdate DATETIME, PRIMARY KEY (pcucode, visitno, drugcode))`,
  ]) await c.query(ddl);
  for (const t of ["visitdrug", "visit", "cdrug", "cdrugunitsell", "chospital", "office"]) {
    await c.query(`DELETE FROM \`${t}\``);
  }

  await c.query(`INSERT INTO office VALUES ('0000x','placeholder'), (?, 'ทดสอบ')`, [PCUCODE]);
  await c.query(`INSERT INTO chospital VALUES (?, 'สถานพยาบาลทดสอบ')`, [PCUCODE]);
  await c.query(`INSERT INTO cdrugunitsell VALUES ('027','เม็ด')`);
  await c.query(
    `INSERT INTO cdrug (drugcode, drugname, drugtype, drugflag, unitsell, unitusage)
     VALUES ('D001','TEST DRUG','01','1','027','027')`,
  );

  // February 2024, exactly as production has it: two dispensing rows, one of
  // which the centre can never store.
  await c.query(`INSERT INTO visit VALUES (?, 1, '2024-02-15', '2024-02-15 08:00:00')`, [PCUCODE]);
  await c.query(`INSERT INTO visit VALUES (?, 2, '2024-02-20', '2024-02-20 08:00:00')`, [PCUCODE]);
  await c.query(
    `INSERT INTO visitdrug VALUES (?, 1, 'D001', 10, '1x3', '001', '2024-02-15 08:30:00')`, [PCUCODE]);
  await c.query(
    `INSERT INTO visitdrug VALUES (?, 2, '', 5, '1x1', '001', '2024-02-20 08:30:00')`, [PCUCODE]);
  // A later month that is genuinely complete, so the run has something to skip.
  await c.query(`INSERT INTO visit VALUES (?, 3, '2024-03-10', '2024-03-10 08:00:00')`, [PCUCODE]);
  await c.query(
    `INSERT INTO visitdrug VALUES (?, 3, 'D001', 7, '1x1', '001', '2024-03-10 08:30:00')`, [PCUCODE]);
  await c.end();
}

beforeAll(async () => {
  try {
    await buildSource();
    available = true;
  } catch {
    available = false;
    return;
  }

  workDir = mkdtempSync(resolve(tmpdir(), "sdc-reconcile-"));
  process.env.AGENT_DATA_DIR = workDir;

  const { AGENT_HEADERS, buildSigningString, signRequest } = await import("@/lib/shared/canonical");
  const secret = "reconcile-secret-reconcile-secret-reconcile";

  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      const path = req.url ?? "";
      const headers = req.headers as Record<string, string>;
      // Signed with the production signing code, so nothing is being proved
      // through a door the real server does not have.
      const expected = signRequest(
        secret,
        buildSigningString({
          method: req.method ?? "POST",
          path,
          timestamp: headers[AGENT_HEADERS.timestamp],
          nonce: headers[AGENT_HEADERS.nonce],
          body,
        }),
      );
      if (expected !== headers[AGENT_HEADERS.signature]) {
        res.writeHead(401).end(JSON.stringify({ error: { code: "BAD_SIGNATURE" } }));
        return;
      }

      const parsed = body ? JSON.parse(body) : {};
      let payload: Record<string, unknown> = { ok: true };

      if (path.endsWith("/heartbeat")) {
        payload = {
          ok: true,
          config: {
            facilityId: "FAC-1", facilityCode: "TEST-REC", facilityName: "ทดสอบ",
            expectedPcucode: PCUCODE, syncIntervalMinutes: 60, reprocessDays: 7,
            lastSyncedVisitDate: null, uploadChunkSize: 500,
            disabled: false, syncRequested: false, verifyRequested: false,
          },
        };
      } else if (path.endsWith("/sync/start")) {
        calls.starts.push({
          batchRef: String(parsed.batchRef), from: String(parsed.rangeFrom),
          to: String(parsed.rangeTo), recordsRead: Number(parsed.recordsRead),
        });
      } else if (path.endsWith("/sync/complete")) {
        calls.completes.push({
          batchRef: String(parsed.batchRef), status: String(parsed.status),
          lastVisitDate: parsed.lastVisitDate ?? null,
        });
      } else if (path.endsWith("/sync/upload")) {
        const records = (parsed.records ?? []) as unknown[];
        if (records.length) calls.uploads += 1;
        payload = { accepted: records.length, rejected: 0, rejects: [] };
      } else if (path.endsWith("/sync/audit")) {
        payload = { months: calls.auditMonths, total: calls.auditMonths.reduce((a, m) => a + m.rows, 0) };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  writeFileSync(
    resolve(workDir, "agent.config.json"),
    JSON.stringify({
      agentId: "rec-agent", keyId: "rec-key", secret, centralApiUrl: baseUrl,
      facilityId: "FAC-1", facilityCode: "TEST-REC", facilityName: "ทดสอบ",
      expectedPcucode: PCUCODE, installationId: "rec", syncIntervalMinutes: 60,
      reprocessDays: 7, enrolledAt: new Date().toISOString(),
    }),
    "utf8",
  );
  writeFileSync(
    resolve(workDir, "jhcis.json"),
    JSON.stringify({ ...SERVER, database: DB }),
    "utf8",
  );
}, 120_000);

afterAll(async () => {
  server?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

const state = () => JSON.parse(readFileSync(resolve(workDir, "state.json"), "utf8"));
function reset(watermark: string | null) {
  calls.starts.length = 0;
  calls.completes.length = 0;
  calls.uploads = 0;
  writeFileSync(
    resolve(workDir, "state.json"),
    JSON.stringify({ lastSyncedVisitDate: watermark, lastSyncAt: null, batchSequence: 0 }),
    "utf8",
  );
}

let counter = 0;
async function runner() {
  process.env.AGENT_DATA_DIR = workDir;
  const mod = await import(`../agent/src/sync?rec=${counter++}`);
  return new mod.SyncRunner();
}

describe("the rule for what the centre can store", () => {
  it("CASE 1/5: names the permanently unstorable rows, and only those", () => {
    expect(isIneligibleSourceRow({ drugCode: "", visitNo: 1 })).toBe(true);
    expect(isIneligibleSourceRow({ drugCode: "   ", visitNo: 1 })).toBe(true);
    expect(isIneligibleSourceRow({ drugCode: null, visitNo: 1 })).toBe(true);
    expect(isIneligibleSourceRow({ drugCode: "D001", visitNo: 0 })).toBe(true);
    expect(isIneligibleSourceRow({ drugCode: "D001", visitNo: -1 })).toBe(true);
    // A perfectly ordinary row, and one that is merely unusual.
    expect(isIneligibleSourceRow({ drugCode: "D001", visitNo: 1 })).toBe(false);
    expect(isIneligibleSourceRow({ drugCode: " D001 ", visitNo: 999_999 })).toBe(false);
  });

  it("the SQL and the predicate agree, row for row", async () => {
    if (!available) return;
    // The two halves of the rule live side by side precisely so they cannot
    // drift; this asserts it against a real server rather than by reading.
    const c = await mysql.createConnection({ ...SERVER, database: DB });
    const [rows] = (await c.query(
      `SELECT vd.visitno, vd.drugcode, ${INELIGIBLE_SOURCE_ROW_SQL} AS sql_says
         FROM visitdrug vd WHERE vd.pcucode = ?`,
      [PCUCODE],
    )) as [Array<Record<string, unknown>>, unknown];
    await c.end();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const ts = isIneligibleSourceRow({
        drugCode: row.drugcode as string,
        visitNo: Number(row.visitno),
      });
      expect(Boolean(Number(row.sql_says)), `row visitno=${row.visitno}`).toBe(ts);
    }
  });

  it("counts only storable rows per month", async () => {
    if (!available) return;
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const { SchemaInspector } = await import("../agent/src/jhcis/schema-inspector");
    const { UsageExtractor } = await import("../agent/src/jhcis/extractor");
    const db = new JhcisConnection();
    const { mapping } = await new SchemaInspector(db).inspect();
    const tally = await new UsageExtractor(db, mapping!).monthlyTally(PCUCODE, "2024-01-01", "2024-12-31");
    await db.close();

    const feb = tally.find((t) => t.month === "2024-02");
    // Two rows in JHCIS, one of them unstorable: the month counts as one.
    expect(feb?.rows).toBe(1);
    expect(tally.find((t) => t.month === "2024-03")?.rows).toBe(1);
  }, 60_000);
});

describe("a month whose only difference is a row the centre must refuse", () => {
  it("CASE 2/11: matches, uploads nothing, and does not loop", async () => {
    if (!available) return;
    // Exactly production: the centre holds the one storable February row.
    calls.auditMonths = [{ month: "2024-02", rows: 1 }, { month: "2024-03", rows: 1 }];
    reset("2024-02-29");

    const result = await (await runner()).run({ mode: "INCREMENTAL", from: null, to: "2024-03-31" });

    // Nothing was read or sent: the month is accounted for.
    expect(calls.uploads).toBe(0);
    expect(result.recordsRead).toBe(0);
    expect(result.recordsSent).toBe(0);
  }, 120_000);

  it("CASE 6/7: a fully verified range advances progress to the range end", async () => {
    if (!available) return;
    calls.auditMonths = [{ month: "2024-02", rows: 1 }, { month: "2024-03", rows: 1 }];
    reset("2024-02-29");

    await (await runner()).run({ mode: "INCREMENTAL", from: null, to: "2024-03-31" });

    // The watermark used to stay where it was, because a run that needed to
    // move no rows opened no batch and reported no progress.
    expect(state().lastSyncedVisitDate).toBe("2024-03-31");
    expect(calls.completes.at(-1)).toMatchObject({
      status: "COMPLETED",
      lastVisitDate: "2024-03-31",
    });
    // It went through the ordinary authenticated pair, not a side door.
    expect(calls.starts.at(-1)).toMatchObject({ recordsRead: 0 });
  }, 120_000);

  it("CASE 4/8: a genuinely missing row still reads, and does not claim the range", async () => {
    if (!available) return;
    // The centre is short a storable row in March - a real gap.
    calls.auditMonths = [{ month: "2024-02", rows: 1 }, { month: "2024-03", rows: 0 }];
    reset("2024-02-29");

    const result = await (await runner()).run({ mode: "INCREMENTAL", from: null, to: "2024-03-31" });

    // March was read and sent; February was left alone.
    expect(result.recordsRead).toBeGreaterThan(0);
    expect(calls.uploads).toBeGreaterThan(0);
    expect(calls.starts.at(-1)?.from.startsWith("2024-03")).toBe(true);
  }, 120_000);

  it("CASE 9/10: an empty central watermark verifies without re-uploading history", async () => {
    if (!available) return;
    // A newly enrolled agent for a สถานบริการ whose data is already complete -
    // the case that sent production back to 2024 and kept it there.
    calls.auditMonths = [{ month: "2024-02", rows: 1 }, { month: "2024-03", rows: 1 }];
    reset(null);

    const result = await (await runner()).run({
      mode: "INCREMENTAL", from: "2024-01-01", to: "2024-03-31",
    });

    expect(calls.uploads).toBe(0);
    expect(result.recordsSent).toBe(0);
    expect(state().lastSyncedVisitDate).toBe("2024-03-31");
  }, 120_000);

  it("stops opening an empty batch once progress is already at the range end", async () => {
    if (!available) return;
    // The empty verified batch exists to move the watermark. When the
    // watermark is already there it moves nothing, and opening one every
    // scheduled run turns the audit history into noise: the canary ran hourly
    // and reached 115 empty batches out of 136, 107 of them in a single day.
    // A bounded one-per-advance is the point; one-per-cycle for ever is not.
    calls.auditMonths = [{ month: "2024-02", rows: 1 }, { month: "2024-03", rows: 1 }];
    reset("2024-02-29");

    const first = await runner();
    await first.run({ mode: "INCREMENTAL", from: null, to: "2024-03-31" });
    const afterFirst = calls.starts.length;
    expect(state().lastSyncedVisitDate).toBe("2024-03-31");

    // Same range again, nothing new at the source: the first run recorded the
    // advance, so the second has nothing to record.
    await (await runner()).run({ mode: "INCREMENTAL", from: null, to: "2024-03-31" });
    expect(calls.starts.length).toBe(afterFirst);
    // And progress is untouched, not rolled back by the skip.
    expect(state().lastSyncedVisitDate).toBe("2024-03-31");

    // A day with something new still gets its one batch.
    await (await runner()).run({ mode: "INCREMENTAL", from: null, to: "2024-04-30" });
    expect(calls.starts.length).toBe(afterFirst + 1);
    expect(state().lastSyncedVisitDate).toBe("2024-04-30");
  }, 180_000);
});

describe("ELIGIBLE_SOURCE_ROW_SQL", () => {
  it("is the negation of the ineligible rule", () => {
    expect(ELIGIBLE_SOURCE_ROW_SQL).toBe(`NOT ${INELIGIBLE_SOURCE_ROW_SQL}`);
  });
});
