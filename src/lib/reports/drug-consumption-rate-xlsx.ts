/**
 * Builds the Excel export for the average monthly drug usage + reserve report.
 *
 * The numbers are written as real numeric cells (a pharmacist can SUM, sort and
 * recalculate them); a number format shows up to two decimals without touching
 * the stored precision. Drug codes are written as text so a leading zero is
 * never eaten. Thai text is native - exceljs writes UTF-8 throughout.
 */
import ExcelJS from "exceljs";

import type { ReserveUsageRow } from "@/lib/reports/consumption-rate";

export interface ConsumptionRateWorkbookInput {
  facilityLabel: string;
  startMonth: string;
  endMonth: string;
  monthCount: number;
  reserveMonths: number;
  drugTypesLabel: string;
  generatedAt: Date;
  rows: ReserveUsageRow[];
}

export const WORKBOOK_SHEET_NAME = "อัตราการใช้ยาเฉลี่ย";

const NUM_FMT = "#,##0.##"; // up to 2 decimals, thousands sep, never scientific
const TABLE_HEADERS = [
  "ลำดับ",
  "รหัสยา",
  "ชื่อยา",
  "หน่วย",
  "ปริมาณใช้รวม",
  "จำนวนเดือน",
  "เฉลี่ยต่อเดือน",
  "สำรอง (เดือน)",
  "ปริมาณสำรองที่แนะนำ",
];

function formatBangkok(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export async function buildConsumptionRateWorkbook(
  input: ConsumptionRateWorkbookInput,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sankamphaeng Drug Data Center";
  wb.created = input.generatedAt;
  const ws = wb.addWorksheet(WORKBOOK_SHEET_NAME, {
    views: [{ rightToLeft: false }],
  });

  // -- metadata block ---------------------------------------------------------
  const meta: Array<[string, string | number]> = [
    ["ชื่อรายงาน", "อัตราการใช้ยาเฉลี่ย"],
    ["สถานบริการ", input.facilityLabel],
    ["ช่วงเดือน", `${input.startMonth} ถึง ${input.endMonth}`],
    ["จำนวนเดือนที่คำนวณ", input.monthCount],
    ["สำรองคงคลัง (เดือน)", input.reserveMonths],
    ["หมวดยา", input.drugTypesLabel],
    ["วันที่ออกรายงาน", formatBangkok(input.generatedAt)],
  ];
  for (const [label, value] of meta) {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (typeof value === "number") row.getCell(2).numFmt = NUM_FMT;
  }
  ws.addRow([]); // spacer

  // -- table ------------------------------------------------------------------
  const headerRow = ws.addRow(TABLE_HEADERS);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
  });
  const headerRowNumber = headerRow.number;

  input.rows.forEach((r, index) => {
    const row = ws.addRow([
      index + 1,
      r.drugCode,
      r.drugName,
      r.unit ?? "",
      r.totalQuantity,
      r.monthCount,
      r.averagePerMonth,
      r.reserveMonths,
      r.recommendedReserveQuantity,
    ]);
    row.getCell(2).numFmt = "@"; // drug code stays text (keep leading zeros)
    row.getCell(2).value = r.drugCode; // ensure string, not coerced number
    row.getCell(3).alignment = { wrapText: true, vertical: "top" };
    for (const col of [5, 6, 7, 8, 9]) row.getCell(col).numFmt = NUM_FMT;
  });

  // -- shape ------------------------------------------------------------------
  ws.columns = [
    { width: 6 }, // ลำดับ
    { width: 12 }, // รหัสยา
    { width: 40 }, // ชื่อยา
    { width: 10 }, // หน่วย
    { width: 14 }, // ปริมาณใช้รวม
    { width: 11 }, // จำนวนเดือน
    { width: 14 }, // เฉลี่ยต่อเดือน
    { width: 12 }, // สำรอง (เดือน)
    { width: 18 }, // ปริมาณสำรองที่แนะนำ
  ];
  ws.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: TABLE_HEADERS.length },
  };
  ws.views = [{ state: "frozen", ySplit: headerRowNumber }];

  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
