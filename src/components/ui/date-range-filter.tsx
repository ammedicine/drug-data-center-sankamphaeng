import { CalendarRange } from "lucide-react";

import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { inputClass } from "@/components/ui/primitives";
import { recentFiscalYears, type FiscalYear } from "@/lib/fiscal-year";

/**
 * Date-range picker used by the dashboard.
 *
 * Defaults follow the Thai fiscal year (1 ต.ค. - 30 ก.ย.), which is the period
 * every ราชการ drug report is written against; picking a fiscal year fills the
 * two date fields, and the dates can still be adjusted by hand.
 */
export function DateRangeFilter({
  from,
  to,
  fiscal,
  basePath,
  children,
  hiddenFields,
}: {
  from: string;
  to: string;
  /** the fiscal year the current range belongs to */
  fiscal: FiscalYear;
  basePath: string;
  /** extra filter controls rendered inside the same form */
  children?: React.ReactNode;
  hiddenFields?: Record<string, string | undefined>;
}) {
  return (
    <FilterBar
      resetHref={basePath}
      hiddenFields={hiddenFields}
      className="border-0"
      note={
        <span className="inline-flex items-center gap-1.5">
          <CalendarRange aria-hidden className="size-3.5" />
          ค่าเริ่มต้น: {fiscal.label} ถึงวันปัจจุบัน
        </span>
      }
    >
      <FilterField label="ปีงบประมาณ" hint="เลือกแล้วกดค้นหา จะใช้ช่วง 1 ต.ค. - 30 ก.ย.">
        <select name="fy" defaultValue="" className={inputClass}>
          <option value="">กำหนดวันที่เอง</option>
          {recentFiscalYears(5).map((year) => (
            <option key={year.year} value={year.year}>
              {year.label}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField label="ตั้งแต่วันที่">
        <input type="date" name="from" defaultValue={from} className={inputClass} />
      </FilterField>
      <FilterField label="ถึงวันที่">
        <input type="date" name="to" defaultValue={to} className={inputClass} />
      </FilterField>
      {children}
    </FilterBar>
  );
}
