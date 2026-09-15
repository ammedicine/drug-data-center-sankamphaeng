/**
 * The Excel export must be a real .xlsx that Thai text survives and whose
 * numbers are real numeric cells (so a pharmacist can SUM/sort/recalc), with
 * drug codes kept as text so a leading zero is never eaten. Everything here is
 * proven by building the workbook and READING IT BACK with exceljs, never by
 * assuming.
 */
import ExcelJS from "exceljs";
import { describe, expect, it, beforeAll } from "vitest";

import { buildConsumptionRateWorkbook } from "@/lib/reports/drug-consumption-rate-xlsx";
import { withReserve } from "@/lib/reports/consumption-rate";
import { toAverageRows } from "@/lib/services/reports";

const aggregates = [
  { drugCode: "P189", drugName: "SIMVASTATIN 20 MG TAB", drugType: "01", unit: "เม็ด", totalQuantity: 20308 },
  { drugCode: "0125", drugName: "ยาน้ำแก้ไอ", drugType: "10", unit: "ขวด", totalQuantity: 30 },
];

let wb: ExcelJS.Workbook;
let ws: ExcelJS.Worksheet;
let headerRowNumber = 0;

beforeAll(async () => {
  const rows = withReserve(toAverageRows(aggregates, 3), 1.5);
  const buffer = await buildConsumptionRateWorkbook({
    facilityLabel: "RPST-05957 · รพ.สต.บ้านกอสะเลียม",
    startMonth: "2026-06",
    endMonth: "2026-08",
    monthCount: 3,
    reserveMonths: 1.5,
    drugTypesLabel: "ยาแผนปัจจุบัน, ยาสมุนไพร",
    generatedAt: new Date("2026-09-15T04:30:00Z"),
    rows,
  });
  wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  ws = wb.worksheets[0];
  ws.eachRow((r, n) => {
    if (String(r.getCell(1).value ?? "").trim() === "ลำดับ") headerRowNumber = n;
  });
});

describe("workbook shape and Thai text", () => {
  it("is a valid workbook with the named worksheet", () => {
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(1);
    expect(ws.name).toBe("อัตราการใช้ยาเฉลี่ย");
  });
  it("carries the report metadata in Thai", () => {
    const flat = JSON.stringify(ws.getSheetValues());
    expect(flat).toContain("อัตราการใช้ยาเฉลี่ย");
    expect(flat).toContain("สำรองคงคลัง");
    expect(flat).toContain("รพ.สต.บ้านกอสะเลียม");
    expect(flat).toContain("2026-06");
    expect(flat).toContain("2026-08");
  });
  it("has the table header with the reserve columns", () => {
    expect(headerRowNumber).toBeGreaterThan(0);
    const headers = (ws.getRow(headerRowNumber).values as unknown[]).map((v) => String(v ?? ""));
    for (const col of ["ลำดับ", "รหัสยา", "ชื่อยา", "หน่วย", "ปริมาณใช้รวม", "จำนวนเดือน", "เฉลี่ยต่อเดือน", "สำรอง (เดือน)", "ปริมาณสำรองที่แนะนำ"]) {
      expect(headers).toContain(col);
    }
  });
});

describe("numeric cells and text-safe codes", () => {
  function dataRow(drugCode: string) {
    let found: ExcelJS.Row | null = null;
    ws.eachRow((r, n) => {
      if (n > headerRowNumber && String(r.getCell(2).value ?? "") === drugCode) found = r;
    });
    if (!found) throw new Error(`row for ${drugCode} not found`);
    return found as ExcelJS.Row;
  }

  it("keeps a known Thai drug name intact", () => {
    expect(String(dataRow("0125").getCell(3).value)).toBe("ยาน้ำแก้ไอ");
  });

  it("keeps drug code as text so a leading zero is not lost", () => {
    const cell = dataRow("0125").getCell(2);
    expect(typeof cell.value).toBe("string");
    expect(cell.value).toBe("0125");
  });

  it("SIMVASTATIN: total/months/average/reserve/recommended are REAL numbers", () => {
    const r = dataRow("P189");
    const total = r.getCell(5).value as number;
    const months = r.getCell(6).value as number;
    const average = r.getCell(7).value as number;
    const reserve = r.getCell(8).value as number;
    const recommended = r.getCell(9).value as number;
    for (const [label, v] of [["total", total], ["months", months], ["average", average], ["reserve", reserve], ["recommended", recommended]] as const) {
      expect(typeof v, label).toBe("number");
    }
    expect(total).toBe(20308);
    expect(months).toBe(3);
    expect(average).toBeCloseTo(6769.3333, 3);
    expect(reserve).toBe(1.5);
    // 20308 / 3 × 1.5 = 10154 exactly; stored full precision, not display-rounded.
    expect(recommended).toBeCloseTo(10154, 6);
  });
});
