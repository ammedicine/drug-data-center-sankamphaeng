/**
 * Month-range maths for the average monthly drug usage report.
 *
 * The denominator of the average is a count of CALENDAR months, inclusive of
 * both ends - a month with zero dispensing still divides the total. Getting
 * this count wrong (e.g. Jan..Mar = 2 instead of 3) silently inflates every
 * average on the page, so it is pinned down here before anything queries a row.
 */
import { describe, expect, it } from "vitest";

import { parseMonth, monthCount, lastDayOfMonth, resolveMonthRange, currentMonthInput } from "@/lib/month-range";

describe("month parsing", () => {
  it("accepts YYYY-MM and rejects anything else", () => {
    expect(parseMonth("2026-01")).toEqual({ year: 2026, month: 1 });
    expect(parseMonth("2026-12")).toEqual({ year: 2026, month: 12 });
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseMonth("2026-00")).toBeNull();
    expect(parseMonth("2026-1")).toBeNull();
    expect(parseMonth("2026/01")).toBeNull();
    expect(parseMonth("")).toBeNull();
    expect(parseMonth(null)).toBeNull();
    expect(parseMonth(undefined)).toBeNull();
  });
});

describe("inclusive month count", () => {
  it("A. 2026-01 -> 2026-03 = 3 months", () => {
    expect(monthCount({ year: 2026, month: 1 }, { year: 2026, month: 3 })).toBe(3);
  });
  it("B. 2026-01 -> 2026-01 = 1 month", () => {
    expect(monthCount({ year: 2026, month: 1 }, { year: 2026, month: 1 })).toBe(1);
  });
  it("C. 2025-11 -> 2026-01 = 3 months (crosses the year)", () => {
    expect(monthCount({ year: 2025, month: 11 }, { year: 2026, month: 1 })).toBe(3);
  });
  it("a full year 2025-01 -> 2025-12 = 12 months", () => {
    expect(monthCount({ year: 2025, month: 1 }, { year: 2025, month: 12 })).toBe(12);
  });
});

describe("last day of month", () => {
  it("knows 30/31-day months and leap February", () => {
    expect(lastDayOfMonth(2026, 3)).toBe(31);
    expect(lastDayOfMonth(2026, 4)).toBe(30);
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2024, 2)).toBe(29); // leap year
  });
});

describe("resolveMonthRange -> from/to/monthCount", () => {
  it("A. 2026-01..2026-03 spans 2026-01-01 to 2026-03-31, 3 months", () => {
    const r = resolveMonthRange("2026-01", "2026-03");
    expect(r).toEqual({ ok: true, range: { from: "2026-01-01", to: "2026-03-31", monthCount: 3 } });
  });
  it("B. single month 2026-01 spans the whole month, 1 month", () => {
    const r = resolveMonthRange("2026-01", "2026-01");
    expect(r).toEqual({ ok: true, range: { from: "2026-01-01", to: "2026-01-31", monthCount: 1 } });
  });
  it("C. 2025-11..2026-01 crosses the year, 3 months", () => {
    const r = resolveMonthRange("2025-11", "2026-01");
    expect(r).toEqual({ ok: true, range: { from: "2025-11-01", to: "2026-01-31", monthCount: 3 } });
  });
  it("leap February end is the 29th", () => {
    const r = resolveMonthRange("2024-02", "2024-02");
    expect(r.ok && r.range.to).toBe("2024-02-29");
  });
  it("D. start after end is a validation error, not a query", () => {
    const r = resolveMonthRange("2026-03", "2026-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });
  it("malformed input is a validation error", () => {
    expect(resolveMonthRange("2026-13", "2026-03").ok).toBe(false);
    expect(resolveMonthRange("", "2026-03").ok).toBe(false);
    expect(resolveMonthRange("2026-03", "nope").ok).toBe(false);
  });
});

describe("currentMonthInput", () => {
  it("formats a date as YYYY-MM", () => {
    expect(currentMonthInput(new Date("2026-09-15T10:00:00"))).toBe("2026-09");
    expect(currentMonthInput(new Date("2026-01-01T00:00:00"))).toBe("2026-01");
  });
});
