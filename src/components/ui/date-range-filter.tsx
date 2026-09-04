import Link from "next/link";

import { Button, Field, inputClass } from "@/components/ui/primitives";
import { recentFiscalYears, type FiscalYear } from "@/lib/fiscal-year";

/**
 * Date-range picker used by the dashboard and the report.
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
  const years = recentFiscalYears(5);

  return (
    <form method="get" className="space-y-4 p-5">
      {Object.entries(hiddenFields ?? {}).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="ปีงบประมาณ" hint="เลือกแล้วกด “ค้นหา” จะใช้ช่วง 1 ต.ค. - 30 ก.ย.">
          <select name="fy" defaultValue="" className={inputClass}>
            <option value="">— กำหนดวันที่เอง —</option>
            {years.map((year) => (
              <option key={year.year} value={year.year}>
                {year.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ตั้งแต่วันที่">
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </Field>
        <Field label="ถึงวันที่">
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </Field>
        {children}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">ค้นหา</Button>
        <Link href={basePath} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-canvas">
          กลับค่าเริ่มต้น
        </Link>
        <span className="text-xs text-muted">ค่าเริ่มต้น: {fiscal.label} ถึงวันปัจจุบัน</span>
      </div>
    </form>
  );
}
