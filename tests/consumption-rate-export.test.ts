/**
 * The Excel export endpoint, against a real MySQL, proving it enforces the same
 * server-side authorization as the page (a facility user cannot export another
 * สถานบริการ), validates the month range and reserve months before producing a
 * file, and returns a real .xlsx with a UTF-8 filename and no patient-level data.
 */
import ExcelJS from "exceljs";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// unstable_cache needs a Next request scope; the cache is a thin pass-through.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: () => {},
}));

// The real RBAC module is kept intact (resolveFacilityScope/resolveDrugTypeScope
// and the error classes stay a single class identity, so the route's instanceof
// checks match); only who is signed in is spied per test.

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_avg_export";

let available = false;
let setupError: unknown = null;
let route: typeof import("@/app/api/reports/drug-consumption-rate/export/route");
let rbac: typeof import("@/lib/auth/rbac");

function requireDatabase() {
  if (!available) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(`export gate needs MySQL on ${SERVER.host}:${SERVER.port}; cause: ${detail}`);
  }
}

const SUPER = { userId: "u-super", email: "super@test", role: "SUPER_ADMIN", facilityId: null } as const;
const FAC_A_USER = { userId: "u-a", email: "a@test", role: "USER", facilityId: "fac-a" } as const;

function makeReq(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://localhost/api/reports/drug-consumption-rate/export?${qs}`) as unknown as import("next/server").NextRequest;
}

let seq = 0;
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

    const c = await mysql.createConnection({ ...SERVER, database: DB });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await c.query(
      `INSERT INTO facilities (id, code, name, jhcis_pcucode, is_active, created_at, updated_at)
       VALUES ('fac-a','RPST-05957','รพ.สต.บ้านกอสะเลียม','05957',1,?,?),
              ('fac-b','RPST-05954','รพ.สต.บ้านสันโค้ง','05954',1,?,?)`,
      [now, now, now, now],
    );
    const ins = async (fac: string, code: string, type: string, date: string, qty: string, name: string) => {
      seq += 1;
      await c.query(
        `INSERT INTO drug_usage (record_key, facility_id, drug_code, drug_name_snapshot, drug_type,
           visit_no, usage_date, quantity, unit, source_pcucode, sync_batch_id, agent_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`rk-${seq}`, fac, code, name, type, 1000 + seq, date, qty, "เม็ด", fac === "fac-a" ? "05957" : "05954", "b", "ag", now, now],
      );
    };
    await ins("fac-a", "P189", "01", "2026-06-10", "20308.00", "SIMVASTATIN 20 MG TAB");
    await ins("fac-a", "0125", "10", "2026-07-10", "30.00", "ยาน้ำแก้ไอ");
    await ins("fac-b", "P189", "01", "2026-06-10", "40.00", "SIMVASTATIN 20 MG TAB");
    await c.end();

    route = await import("@/app/api/reports/drug-consumption-rate/export/route");
    rbac = await import("@/lib/auth/rbac");
    available = true;
  } catch (error) {
    console.error("[export gate] setup failed:", error);
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
    /* ignore */
  }
  delete process.env.DATABASE_URL;
});

beforeEach(() => vi.restoreAllMocks());

const OK_PARAMS = { startMonth: "2026-06", endMonth: "2026-08", facility: "fac-a", types: "01,10", reserveMonths: "1.5" };

describe("authorization", () => {
  it("returns 401 when not signed in", async () => {
    requireDatabase();
    vi.spyOn(rbac, "requireApiUser").mockRejectedValue(new rbac.UnauthorizedError());
    const res = await route.GET(makeReq(OK_PARAMS));
    expect(res.status).toBe(401);
  });

  it("returns 403 when a facility user asks for another facility", async () => {
    requireDatabase();
    vi.spyOn(rbac, "requireApiUser").mockResolvedValue(FAC_A_USER as never);
    const res = await route.GET(makeReq({ ...OK_PARAMS, facility: "fac-b" }));
    expect(res.status).toBe(403);
  });
});

describe("validation refuses a misleading file", () => {
  beforeEach(() => vi.spyOn(rbac, "requireApiUser").mockResolvedValue(SUPER as never));
  it("rejects start month after end month", async () => {
    requireDatabase();
    const res = await route.GET(makeReq({ ...OK_PARAMS, startMonth: "2026-09", endMonth: "2026-08" }));
    expect(res.status).toBe(400);
  });
  it("rejects an out-of-range reserve", async () => {
    requireDatabase();
    expect((await route.GET(makeReq({ ...OK_PARAMS, reserveMonths: "13" }))).status).toBe(400);
    expect((await route.GET(makeReq({ ...OK_PARAMS, reserveMonths: "-1" }))).status).toBe(400);
    expect((await route.GET(makeReq({ ...OK_PARAMS, reserveMonths: "abc" }))).status).toBe(400);
  });
});

describe("a valid export", () => {
  beforeEach(() => vi.spyOn(rbac, "requireApiUser").mockResolvedValue(SUPER as never));

  it("returns a real xlsx with a UTF-8 filename and correct numbers, no patient fields", async () => {
    requireDatabase();
    const res = await route.GET(makeReq(OK_PARAMS));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toMatch(/filename\*=UTF-8''/); // RFC 5987 UTF-8 filename

    const buffer = await res.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];

    let headerRow = 0;
    ws.eachRow((r, n) => {
      if (String(r.getCell(1).value ?? "").trim() === "ลำดับ") headerRow = n;
    });
    expect(headerRow).toBeGreaterThan(0);
    const headers = (ws.getRow(headerRow).values as unknown[]).filter(Boolean).map(String);
    expect(headers).toEqual([
      "ลำดับ", "รหัสยา", "ชื่อยา", "หน่วย", "ปริมาณใช้รวม", "จำนวนเดือน", "เฉลี่ยต่อเดือน", "สำรอง (เดือน)", "ปริมาณสำรองที่แนะนำ",
    ]);
    // no patient-level column ever
    expect(JSON.stringify(headers)).not.toMatch(/visit|pid|patient|hn/i);

    // SIMVASTATIN row: fac-a total 20308 (fac-b's 40 must not bleed in).
    let sim: ExcelJS.Row | null = null;
    ws.eachRow((r, n) => {
      if (n > headerRow && String(r.getCell(2).value ?? "") === "P189") sim = r;
    });
    const row = sim as unknown as ExcelJS.Row;
    expect(row.getCell(5).value).toBe(20308);
    expect(row.getCell(6).value).toBe(3);
    expect(row.getCell(9).value as number).toBeCloseTo(10154, 6); // 20308/3×1.5
  });
});
