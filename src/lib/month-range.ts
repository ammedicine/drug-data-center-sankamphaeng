/**
 * Calendar-month maths for the average monthly drug usage report.
 *
 * The report divides a total by a count of months, and that count is INCLUSIVE
 * of both ends: January to March is three months, not two, and a month in the
 * middle with no dispensing still counts in the denominator. Keeping this in
 * one pure module means the rule is tested once and cannot drift between the
 * page, the service, and whatever reuses it later.
 */

export interface MonthParts {
  year: number;
  /** 1-12 */
  month: number;
}

export interface ResolvedMonthRange {
  /** first day of the start month, yyyy-mm-dd */
  from: string;
  /** last day of the end month, yyyy-mm-dd */
  to: string;
  /** inclusive count of calendar months in [start, end] */
  monthCount: number;
}

export type MonthRangeResult =
  | { ok: true; range: ResolvedMonthRange }
  | { ok: false; error: string };

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Parses a strict `YYYY-MM`; anything else (bad month, wrong shape) is null. */
export function parseMonth(value: string | null | undefined): MonthParts | null {
  if (typeof value !== "string") return null;
  const match = MONTH_RE.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** Days in a month. `month` is 1-12; day 0 of the next month is the last of this one. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Inclusive month count: Jan..Mar = 3, Jan..Jan = 1. May be <= 0 if end < start. */
export function monthCount(start: MonthParts, end: MonthParts): number {
  return (end.year - start.year) * 12 + (end.month - start.month) + 1;
}

/**
 * Turns two `YYYY-MM` inputs into a date window and a month count, or an error
 * the page can show. A start after the end is a validation error, never a query.
 */
export function resolveMonthRange(
  startMonth: string | null | undefined,
  endMonth: string | null | undefined,
): MonthRangeResult {
  const start = parseMonth(startMonth);
  const end = parseMonth(endMonth);
  if (!start || !end) {
    return { ok: false, error: "รูปแบบเดือนไม่ถูกต้อง กรุณาเลือกเดือนเริ่มต้นและเดือนสิ้นสุด" };
  }
  const count = monthCount(start, end);
  if (count < 1) {
    return { ok: false, error: "เดือนเริ่มต้นต้องไม่อยู่หลังเดือนสิ้นสุด" };
  }
  return {
    ok: true,
    range: {
      from: `${pad(start.year, 4)}-${pad(start.month, 2)}-01`,
      to: `${pad(end.year, 4)}-${pad(end.month, 2)}-${pad(lastDayOfMonth(end.year, end.month), 2)}`,
      monthCount: count,
    },
  };
}

/** The current month as a `YYYY-MM` string, for input defaults and the "unfinished month" note. */
export function currentMonthInput(date = new Date()): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}`;
}
