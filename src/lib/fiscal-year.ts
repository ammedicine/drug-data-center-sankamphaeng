/**
 * Thai fiscal year (ปีงบประมาณ): 1 October to 30 September.
 * FY 2569 runs 2025-10-01 .. 2026-09-30 and is named after its Buddhist-era
 * end year, which is how every ราชการ report labels it.
 */

export interface FiscalYear {
  /** Buddhist-era year, e.g. 2569 */
  year: number;
  start: string; // yyyy-mm-dd
  end: string; // yyyy-mm-dd
  label: string; // "ปีงบประมาณ 2569 (1 ต.ค. 2568 - 30 ก.ย. 2569)"
}

const THAI_MONTHS_SHORT = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The fiscal year a given date falls in (defaults to today). */
export function fiscalYearOf(date = new Date()): FiscalYear {
  const gregorianYear = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  // October onwards already belongs to the next fiscal year
  const endYear = month >= 10 ? gregorianYear + 1 : gregorianYear;
  return buildFiscalYear(endYear + 543);
}

/** Builds a fiscal year from its Buddhist-era number (e.g. 2569). */
export function buildFiscalYear(buddhistYear: number): FiscalYear {
  const endGregorian = buddhistYear - 543;
  const startGregorian = endGregorian - 1;
  return {
    year: buddhistYear,
    start: iso(startGregorian, 10, 1),
    end: iso(endGregorian, 9, 30),
    label: `ปีงบประมาณ ${buddhistYear} (1 ${THAI_MONTHS_SHORT[9]} ${startGregorian + 543} - 30 ${
      THAI_MONTHS_SHORT[8]
    } ${buddhistYear})`,
  };
}

/**
 * Default reporting window: the current fiscal year, ending today rather than
 * on 30 September so the report never shows an empty future stretch.
 */
export function currentFiscalRange(today = new Date()): { from: string; to: string; fiscal: FiscalYear } {
  const fiscal = fiscalYearOf(today);
  const todayIso = iso(today.getFullYear(), today.getMonth() + 1, today.getDate());
  return { from: fiscal.start, to: todayIso < fiscal.end ? todayIso : fiscal.end, fiscal };
}

/** Recent fiscal years for a picker, newest first. */
export function recentFiscalYears(count = 5, today = new Date()): FiscalYear[] {
  const current = fiscalYearOf(today).year;
  return Array.from({ length: count }, (_, index) => buildFiscalYear(current - index));
}
