/**
 * The page's submit/validate decision, kept pure so it is tested without a
 * browser (the project has no DOM test harness) and the server component stays
 * a thin renderer over it.
 *
 * The workflow is explicit: the user picks two months and presses คำนวณ. Until
 * both months are submitted the page shows only the form and the formula - it
 * does not run a report to fill a blank page. A start after the end is a clear
 * error, not a query.
 */
import { currentMonthInput, resolveMonthRange } from "@/lib/month-range";

export interface ConsumptionRateView {
  mode: "form" | "result" | "error";
  /** the YYYY-MM to show in the start input (defaults to the current month) */
  startMonth: string;
  /** the YYYY-MM to show in the end input (defaults to the current month) */
  endMonth: string;
  monthCount: number | null;
  from: string | null;
  to: string | null;
  error: string | null;
  /** the chosen end month is the current, unfinished calendar month */
  currentMonthNote: boolean;
}

export function planConsumptionRateReport(
  params: { startMonth?: string | null; endMonth?: string | null },
  opts: { today?: Date } = {},
): ConsumptionRateView {
  const current = currentMonthInput(opts.today ?? new Date());
  const startMonth = params.startMonth || current;
  const endMonth = params.endMonth || current;
  const submitted = Boolean(params.startMonth && params.endMonth);

  const base = { startMonth, endMonth, monthCount: null, from: null, to: null, error: null, currentMonthNote: false } as const;

  if (!submitted) {
    return { ...base, mode: "form" };
  }

  const resolved = resolveMonthRange(startMonth, endMonth);
  if (!resolved.ok) {
    return { ...base, mode: "error", error: resolved.error };
  }

  return {
    mode: "result",
    startMonth,
    endMonth,
    monthCount: resolved.range.monthCount,
    from: resolved.range.from,
    to: resolved.range.to,
    error: null,
    currentMonthNote: endMonth === current,
  };
}
