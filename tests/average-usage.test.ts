/**
 * The average itself, and the page's submit/validate behaviour - both pure, so
 * they are proven without a database or a browser.
 *
 * Formula (owner-approved): average per month = total quantity in the window
 * divided by the inclusive count of calendar months. A month with zero usage
 * contributes zero to the numerator but still counts in the denominator, so
 * 100 (Jan) + 0 (Feb) + 50 (Mar) over three months is 50, never 75.
 */
import { describe, expect, it } from "vitest";

import { toAverageRows, summariseAverageUsage } from "@/lib/services/reports";
import { planConsumptionRateReport } from "@/lib/reports/consumption-rate";

const agg = (drugCode: string, totalQuantity: number, over: Partial<{ drugName: string; drugType: string | null; unit: string | null }> = {}) => ({
  drugCode,
  drugName: over.drugName ?? drugCode,
  drugType: over.drugType ?? "01",
  unit: over.unit ?? "เม็ด",
  totalQuantity,
});

describe("average per month", () => {
  it("E. Jan 100 + Feb 0 + Mar 50 = 150 over 3 months = 50 (zero month still divides)", () => {
    const [row] = toAverageRows([agg("A", 150)], 3);
    expect(row.totalQuantity).toBe(150);
    expect(row.monthCount).toBe(3);
    expect(row.averagePerMonth).toBe(50);
  });

  it("F. decimals are preserved: 10.5 over 2 months = 5.25", () => {
    const [row] = toAverageRows([agg("B", 10.5)], 2);
    expect(row.averagePerMonth).toBe(5.25);
  });

  it("carries drug metadata through unchanged", () => {
    const [row] = toAverageRows([agg("P189", 300, { drugName: "Paracetamol 500 mg", unit: "เม็ด" })], 3);
    expect(row).toMatchObject({ drugCode: "P189", drugName: "Paracetamol 500 mg", unit: "เม็ด", drugType: "01", averagePerMonth: 100 });
  });

  it("G. no rows returns an empty list and a zero, never NaN/Infinity", () => {
    expect(toAverageRows([], 3)).toEqual([]);
    const s = summariseAverageUsage([], 3);
    expect(s).toEqual({ distinctDrugs: 0, totalQuantity: 0, averageTotalPerMonth: 0 });
    expect(Number.isFinite(s.averageTotalPerMonth)).toBe(true);
  });

  it("never divides by zero even if monthCount is 0", () => {
    expect(toAverageRows([agg("A", 100)], 0)[0].averagePerMonth).toBe(0);
    expect(summariseAverageUsage([{ totalQuantity: 100 }], 0).averageTotalPerMonth).toBe(0);
  });

  it("summary total average is SUM(total)/monthCount, not an average of averages", () => {
    const rows = toAverageRows([agg("A", 300), agg("B", 150)], 3);
    const s = summariseAverageUsage(rows, 3);
    expect(s.distinctDrugs).toBe(2);
    expect(s.totalQuantity).toBe(450);
    expect(s.averageTotalPerMonth).toBe(150); // 450 / 3, not (100+50)/2
  });
});

describe("page submit/validate planning", () => {
  const today = new Date("2026-09-15T10:00:00");

  it("first visit (no params) shows the form with current-month defaults, no results", () => {
    const v = planConsumptionRateReport({}, { today });
    expect(v.mode).toBe("form");
    expect(v.startMonth).toBe("2026-09");
    expect(v.endMonth).toBe("2026-09");
    expect(v.monthCount).toBeNull();
  });

  it("a valid submitted range produces a result with the right window and month count", () => {
    const v = planConsumptionRateReport({ startMonth: "2026-01", endMonth: "2026-03" }, { today });
    expect(v.mode).toBe("result");
    expect(v.from).toBe("2026-01-01");
    expect(v.to).toBe("2026-03-31");
    expect(v.monthCount).toBe(3);
    expect(v.error).toBeNull();
  });

  it("start after end is a clear error and does not become a result", () => {
    const v = planConsumptionRateReport({ startMonth: "2026-03", endMonth: "2026-01" }, { today });
    expect(v.mode).toBe("error");
    expect(v.error).toBeTruthy();
    expect(v.from).toBeNull();
  });

  it("flags when the selected end month is the current (unfinished) month", () => {
    const cur = planConsumptionRateReport({ startMonth: "2026-01", endMonth: "2026-09" }, { today });
    expect(cur.currentMonthNote).toBe(true);
    const past = planConsumptionRateReport({ startMonth: "2026-01", endMonth: "2026-03" }, { today });
    expect(past.currentMonthNote).toBe(false);
  });
});
