/**
 * The average-usage aggregate, run against a real MySQL with the real
 * migrations - the same reasoning as the fleet gate: a query that groups and
 * sums is exactly the kind of thing a mocked test waves through and a real
 * schema rejects.
 *
 * The fixture is built to catch the failure modes that matter:
 *  - a drug used only in the first and last month (the middle month is zero and
 *    must still count in the denominator);
 *  - the SAME drug code at two สถานบริการ (facility scope must not bleed);
 *  - a non-drug category present in the data (type scope must exclude it);
 *  - decimal quantities (the average must not be rounded away at the source).
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// unstable_cache needs a Next.js request scope, which a node test has not. The
// cache is a thin pass-through wrapper (report-cache.ts); mocking it here lets
// the test exercise the real public getAverageMonthlyDrugUsage and its SQL.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: () => {},
}));

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_avg_usage";

let available = false;
let setupError: unknown = null;
let reports: typeof import("@/lib/services/reports");

function requireDatabase() {
  if (!available) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(
      `The average-usage gate needs MySQL on ${SERVER.host}:${SERVER.port} and a working fixture, ` +
        `and did not get one. This test must never pass without a database. Cause: ${detail}`,
    );
  }
}

/** One dispensing row. quantity is a string because the column is DECIMAL. */
let seq = 0;
function usageRow(facilityId: string, drugCode: string, drugType: string, date: string, qty: string, name: string, unit: string) {
  seq += 1;
  return {
    record_key: `rk-${facilityId}-${drugCode}-${seq}`.padEnd(0, "0").slice(0, 64),
    facility_id: facilityId,
    drug_code: drugCode,
    drug_name_snapshot: name,
    drug_type: drugType,
    visit_no: 1000 + seq,
    usage_date: date,
    quantity: qty,
    unit,
    source_pcucode: facilityId === "fac-a" ? "05957" : "05954",
    sync_batch_id: "batch-x",
    agent_id: "agent-x",
  };
}

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
    const migConn = await mysql.createConnection({ uri: process.env.DATABASE_URL, multipleStatements: true });
    await migrate(drizzle(migConn), { migrationsFolder: "./drizzle" });
    await migConn.end();

    const c = await mysql.createConnection({ ...SERVER, database: DB });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await c.query(
      `INSERT INTO facilities (id, code, name, jhcis_pcucode, is_active, created_at, updated_at)
       VALUES ('fac-a','RPST-05957','รพ.สต.บ้านกอสะเลียม','05957',1,?,?),
              ('fac-b','RPST-05954','รพ.สต.บ้านสันโค้ง','05954',1,?,?)`,
      [now, now, now, now],
    );

    const rows = [
      // Facility A, drug A (01): Jan 100, Mar 50 -> Feb is a zero month.
      usageRow("fac-a", "A", "01", "2026-01-10", "100.00", "ยาเอ", "เม็ด"),
      usageRow("fac-a", "A", "01", "2026-03-05", "50.00", "ยาเอ", "เม็ด"),
      // Facility A, drug B (01): decimals -> Jan 10.5, Feb 0, Mar 0.
      usageRow("fac-a", "B", "01", "2026-01-20", "10.50", "ยาบี", "ขวด"),
      // Facility A, a NON-drug category (02) -> must be excluded by type scope.
      usageRow("fac-a", "S", "02", "2026-02-01", "999.00", "เวชภัณฑ์", "ชิ้น"),
      // Facility A, out-of-window row (Dec) -> must not count.
      usageRow("fac-a", "A", "01", "2025-12-31", "777.00", "ยาเอ", "เม็ด"),
      // Facility B, SAME drug code A -> must never bleed into A's scope.
      usageRow("fac-b", "A", "01", "2026-02-15", "40.00", "ยาเอ", "เม็ด"),
    ];
    for (const r of rows) {
      await c.query(
        `INSERT INTO drug_usage (record_key, facility_id, drug_code, drug_name_snapshot, drug_type,
           visit_no, usage_date, quantity, unit, source_pcucode, sync_batch_id, agent_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.record_key, r.facility_id, r.drug_code, r.drug_name_snapshot, r.drug_type, r.visit_no, r.usage_date, r.quantity, r.unit, r.source_pcucode, r.sync_batch_id, r.agent_id, now, now],
      );
    }
    await c.end();

    reports = await import("@/lib/services/reports");
    available = true;
  } catch (error) {
    console.error("[avg-usage gate] setup failed:", error);
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

const janToMar = { from: "2026-01-01", to: "2026-03-31" };

describe("getAverageMonthlyDrugUsage", () => {
  it("groups by drug, sums quantity in the window, and divides by the inclusive month count", async () => {
    requireDatabase();
    const { rows } = await reports.getAverageMonthlyDrugUsage(
      { facilityIds: ["fac-a"], ...janToMar, drugTypes: ["01"] },
      3,
    );
    const a = rows.find((r) => r.drugCode === "A")!;
    const b = rows.find((r) => r.drugCode === "B")!;

    // Drug A: 100 (Jan) + 50 (Mar); Feb contributes nothing but still divides.
    expect(a.totalQuantity).toBe(150);
    expect(a.monthCount).toBe(3);
    expect(a.averagePerMonth).toBe(50);
    // Out-of-window December (777) was not counted.

    // Drug B: 10.5 over three months = 3.5, decimals intact.
    expect(b.totalQuantity).toBe(10.5);
    expect(b.averagePerMonth).toBeCloseTo(3.5, 10);
  });

  it("excludes non-drug categories via the type scope", async () => {
    requireDatabase();
    const { rows } = await reports.getAverageMonthlyDrugUsage(
      { facilityIds: ["fac-a"], ...janToMar, drugTypes: ["01"] },
      3,
    );
    expect(rows.find((r) => r.drugCode === "S")).toBeUndefined();
  });

  it("respects facility scope: drug A at fac-b does not bleed into fac-a", async () => {
    requireDatabase();
    const a = await reports.getAverageMonthlyDrugUsage({ facilityIds: ["fac-a"], ...janToMar, drugTypes: ["01"] }, 3);
    const b = await reports.getAverageMonthlyDrugUsage({ facilityIds: ["fac-b"], ...janToMar, drugTypes: ["01"] }, 3);
    // fac-a's drug A is 150; fac-b's drug A is 40 - never merged.
    expect(a.rows.find((r) => r.drugCode === "A")!.totalQuantity).toBe(150);
    expect(b.rows.find((r) => r.drugCode === "A")!.totalQuantity).toBe(40);
  });

  it("returns nothing but a safe zero summary for an empty window", async () => {
    requireDatabase();
    const { rows, summary } = await reports.getAverageMonthlyDrugUsage(
      { facilityIds: ["fac-a"], from: "2020-01-01", to: "2020-01-31", drugTypes: ["01"] },
      1,
    );
    expect(rows).toEqual([]);
    expect(summary.totalQuantity).toBe(0);
    expect(summary.averageTotalPerMonth).toBe(0);
    expect(summary.distinctDrugs).toBe(0);
  });

  it("summary total average is SUM over months, not an average of per-drug averages", async () => {
    requireDatabase();
    const { summary } = await reports.getAverageMonthlyDrugUsage(
      { facilityIds: ["fac-a"], ...janToMar, drugTypes: ["01"] },
      3,
    );
    // A(150) + B(10.5) = 160.5 over 3 months.
    expect(summary.totalQuantity).toBe(160.5);
    expect(summary.averageTotalPerMonth).toBeCloseTo(53.5, 10);
    expect(summary.distinctDrugs).toBe(2);
  });

  it("returns no patient-level fields, only aggregated drug rows", async () => {
    requireDatabase();
    const { rows } = await reports.getAverageMonthlyDrugUsage({ facilityIds: ["fac-a"], ...janToMar, drugTypes: ["01"] }, 3);
    const keys = Object.keys(rows[0]).join(",").toLowerCase();
    expect(keys).not.toMatch(/visit|pid|patient|record_key|name_snapshot|hn/);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["averagePerMonth", "drugCode", "drugName", "drugType", "monthCount", "totalQuantity", "unit"].sort(),
    );
  });
});
