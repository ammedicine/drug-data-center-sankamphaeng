/**
 * The page's submit/validate decision, kept pure so it is tested without a
 * browser (the project has no DOM test harness) and the server component stays
 * a thin renderer over it.
 *
 * The workflow is explicit: the user picks two months and a reserve-months
 * value, then presses คำนวณ. Until both months are submitted the page shows only
 * the form and the formula - it does not run a report to fill a blank page. A
 * start after the end, or a reserve outside 0..12, is a clear error, not a query.
 */
import { currentMonthInput, resolveMonthRange } from "@/lib/month-range";
import type { AverageMonthlyDrugUsageRow } from "@/lib/services/reports";

/** Reserve-stock: how many months of average usage to keep on hand. */
export const DEFAULT_RESERVE_MONTHS = 1.5;
export const MIN_RESERVE_MONTHS = 0;
export const MAX_RESERVE_MONTHS = 12;

export type ReserveResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Validates the reserve-months scalar. Missing/blank means the default (1.5);
 * anything non-finite, negative, or above 12 is rejected rather than silently
 * clamped, so a typo becomes a visible error instead of a wrong plan.
 */
export function parseReserveMonths(raw: string | null | undefined): ReserveResult {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { ok: true, value: DEFAULT_RESERVE_MONTHS };
  }
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    return { ok: false, error: "จำนวนเดือนสำรองต้องเป็นตัวเลข" };
  }
  if (value < MIN_RESERVE_MONTHS || value > MAX_RESERVE_MONTHS) {
    return { ok: false, error: `จำนวนเดือนสำรองต้องอยู่ระหว่าง ${MIN_RESERVE_MONTHS} ถึง ${MAX_RESERVE_MONTHS} เดือน` };
  }
  return { ok: true, value };
}

export interface ReserveUsageRow extends AverageMonthlyDrugUsageRow {
  /** the scalar reserve months applied to the whole report */
  reserveMonths: number;
  /** averagePerMonth × reserveMonths (owner-approved "แบบ A": a multiplier) */
  recommendedReserveQuantity: number;
}

/**
 * Reserve stock = average monthly usage × reserve months. A multiplier, not
 * "total + total×months": 100/month reserved for 1.5 months is 150. Full
 * precision is kept; any rounding is display-only.
 */
export function withReserve(
  rows: AverageMonthlyDrugUsageRow[],
  reserveMonths: number,
): ReserveUsageRow[] {
  return rows.map((r) => ({
    ...r,
    reserveMonths,
    recommendedReserveQuantity: r.averagePerMonth * reserveMonths,
  }));
}

export interface ConsumptionRateView {
  mode: "form" | "result" | "error";
  /** the YYYY-MM to show in the start input (defaults to the current month) */
  startMonth: string;
  /** the YYYY-MM to show in the end input (defaults to the current month) */
  endMonth: string;
  monthCount: number | null;
  from: string | null;
  to: string | null;
  /** the resolved reserve months used in the calculation (default 1.5) */
  reserveMonths: number;
  /** the raw reserve text for the input, so an invalid value can be corrected */
  reserveMonthsInput: string;
  error: string | null;
  /** the chosen end month is the current, unfinished calendar month */
  currentMonthNote: boolean;
}

export function planConsumptionRateReport(
  params: { startMonth?: string | null; endMonth?: string | null; reserveMonths?: string | null },
  opts: { today?: Date } = {},
): ConsumptionRateView {
  const current = currentMonthInput(opts.today ?? new Date());
  const startMonth = params.startMonth || current;
  const endMonth = params.endMonth || current;
  const submitted = Boolean(params.startMonth && params.endMonth);

  const reserve = parseReserveMonths(params.reserveMonths);
  const reserveMonths = reserve.ok ? reserve.value : DEFAULT_RESERVE_MONTHS;
  const reserveMonthsInput =
    params.reserveMonths !== null && params.reserveMonths !== undefined && String(params.reserveMonths).trim() !== ""
      ? String(params.reserveMonths)
      : String(DEFAULT_RESERVE_MONTHS);

  const base = {
    startMonth,
    endMonth,
    monthCount: null,
    from: null,
    to: null,
    reserveMonths,
    reserveMonthsInput,
    error: null,
    currentMonthNote: false,
  } as const;

  if (!submitted) {
    return { ...base, mode: "form" };
  }

  const resolved = resolveMonthRange(startMonth, endMonth);
  if (!resolved.ok) {
    return { ...base, mode: "error", error: resolved.error };
  }
  if (!reserve.ok) {
    return { ...base, mode: "error", error: reserve.error };
  }

  return {
    mode: "result",
    startMonth,
    endMonth,
    monthCount: resolved.range.monthCount,
    from: resolved.range.from,
    to: resolved.range.to,
    reserveMonths: reserve.value,
    reserveMonthsInput,
    error: null,
    currentMonthNote: endMonth === current,
  };
}
