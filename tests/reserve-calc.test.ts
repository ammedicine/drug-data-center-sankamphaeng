/**
 * Reserve stock = average monthly usage × reserve months (owner-approved "แบบ A":
 * a multiplier, NOT total + total×months). So 100/month reserved for 1.5 months
 * is 150, never 250. The reserve months value is a single scalar for the whole
 * report and is validated (finite, 0..12) before anything calculates or exports.
 */
import { describe, expect, it } from "vitest";

import { parseReserveMonths, withReserve } from "@/lib/reports/consumption-rate";
import { planConsumptionRateReport } from "@/lib/reports/consumption-rate";
import { toAverageRows } from "@/lib/services/reports";

const row = (drugCode: string, totalQuantity: number, monthCount: number) =>
  toAverageRows([{ drugCode, drugName: drugCode, drugType: "01", unit: "เม็ด", totalQuantity }], monthCount)[0];

describe("parseReserveMonths validation", () => {
  it("E. missing/empty defaults to 1.5", () => {
    expect(parseReserveMonths(undefined)).toEqual({ ok: true, value: 1.5 });
    expect(parseReserveMonths(null)).toEqual({ ok: true, value: 1.5 });
    expect(parseReserveMonths("")).toEqual({ ok: true, value: 1.5 });
    expect(parseReserveMonths("   ")).toEqual({ ok: true, value: 1.5 });
  });
  it("F. zero is valid", () => {
    expect(parseReserveMonths("0")).toEqual({ ok: true, value: 0 });
  });
  it("G. twelve is valid", () => {
    expect(parseReserveMonths("12")).toEqual({ ok: true, value: 12 });
  });
  it("accepts the fractional values in range", () => {
    expect(parseReserveMonths("0.5").ok && parseReserveMonths("0.5")).toMatchObject({ value: 0.5 });
    expect(parseReserveMonths("1.5")).toEqual({ ok: true, value: 1.5 });
    expect(parseReserveMonths("2.3")).toEqual({ ok: true, value: 2.3 });
  });
  it("H. negative is invalid", () => {
    expect(parseReserveMonths("-0.1").ok).toBe(false);
  });
  it("I. above 12 is invalid", () => {
    expect(parseReserveMonths("12.1").ok).toBe(false);
  });
  it("J. non-numeric is invalid", () => {
    expect(parseReserveMonths("abc").ok).toBe(false);
  });
  it("K. Infinity is invalid", () => {
    expect(parseReserveMonths("Infinity").ok).toBe(false);
    expect(parseReserveMonths("1e400").ok).toBe(false); // overflows to Infinity
  });
});

describe("recommendedReserveQuantity = averagePerMonth × reserveMonths", () => {
  it("A. average 100 × 1.5 = 150", () => {
    expect(withReserve([row("A", 100, 1)], 1.5)[0].recommendedReserveQuantity).toBe(150);
  });
  it("B. average 100 × 2 = 200", () => {
    expect(withReserve([row("A", 100, 1)], 2)[0].recommendedReserveQuantity).toBe(200);
  });
  it("C. average 120.5 × 0.5 = 60.25", () => {
    expect(withReserve([row("A", 120.5, 1)], 0.5)[0].recommendedReserveQuantity).toBe(60.25);
  });
  it("D. average 0 × 1.5 = 0", () => {
    expect(withReserve([row("A", 0, 1)], 1.5)[0].recommendedReserveQuantity).toBe(0);
  });
  it("carries the scalar reserveMonths onto each row", () => {
    const rows = withReserve([row("A", 100, 1), row("B", 60, 1)], 1.5);
    expect(rows.map((r) => r.reserveMonths)).toEqual([1.5, 1.5]);
  });
});

describe("regression: reserve builds on the AVERAGE, not the total or active months", () => {
  it("Jan 100 + Feb 0 + Mar 50 -> total 150 / 3 = 50/month; reserve 1.5 -> 75", () => {
    // A single aggregate row of total 150 over the 3-month window (Feb is a zero
    // month, already folded into the total). Average is 50, reserve 50×1.5 = 75.
    const [averaged] = toAverageRows(
      [{ drugCode: "PARA", drugName: "Paracetamol", drugType: "01", unit: "เม็ด", totalQuantity: 150 }],
      3,
    );
    expect(averaged.averagePerMonth).toBe(50);
    const [withRes] = withReserve([averaged], 1.5);
    expect(withRes.recommendedReserveQuantity).toBe(75); // 50 × 1.5, not 125, not 150, not 150/2×1.5
  });
});

describe("plan integrates reserve validation into the page decision", () => {
  const today = new Date("2026-09-15T10:00:00");
  it("defaults reserve to 1.5 and surfaces it for the input", () => {
    const v = planConsumptionRateReport({ startMonth: "2026-01", endMonth: "2026-03" }, { today });
    expect(v.mode).toBe("result");
    expect(v.reserveMonths).toBe(1.5);
  });
  it("uses a valid submitted reserve", () => {
    const v = planConsumptionRateReport({ startMonth: "2026-01", endMonth: "2026-03", reserveMonths: "2" }, { today });
    expect(v.mode).toBe("result");
    expect(v.reserveMonths).toBe(2);
  });
  it("an invalid reserve is an error, not a misleading result", () => {
    const v = planConsumptionRateReport({ startMonth: "2026-01", endMonth: "2026-03", reserveMonths: "13" }, { today });
    expect(v.mode).toBe("error");
    expect(v.error).toBeTruthy();
  });
  it("keeps the raw reserve text for the input so the user can fix it", () => {
    const v = planConsumptionRateReport({ startMonth: "2026-01", endMonth: "2026-03", reserveMonths: "13" }, { today });
    expect(v.reserveMonthsInput).toBe("13");
  });
});
