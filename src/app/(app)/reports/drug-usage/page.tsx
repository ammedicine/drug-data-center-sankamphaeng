import Link from "next/link";
import {
  Boxes,
  ChartNoAxesCombined,
  Download,
  Layers3,
  ListChecks,
  Pill,
  RotateCcw,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { TrendChart } from "@/components/ui/charts";
import {
  DrugTypeMultiSelect,
  DrugUsageReportViews,
  DrugUsageSearchInput,
  DrugUsageSearchProvider,
} from "@/components/ui/drug-usage-report-workspace";
import { DrugUsageTable } from "@/components/ui/drug-usage-table";
import {
  ErrorState,
  PageHeader,
  buttonClass,
  formatNumber,
  inputClass,
} from "@/components/ui/primitives";
import {
  ForbiddenError,
  requireUser,
  resolveDrugTypeScope,
  resolveFacilityScope,
} from "@/lib/auth/rbac";
import { listFacilityOptions } from "@/lib/services/facilities";
import {
  getAvailableDrugTypes,
  getUsageByDrug,
  getUsageByDrugType,
  getUsageSummary,
  getUsageTrend,
} from "@/lib/services/reports";
import {
  buildFiscalYear,
  currentFiscalRange,
  fiscalYearOf,
  recentFiscalYears,
} from "@/lib/fiscal-year";
import { PRIMARY_DRUG_TYPES, drugTypeLabel } from "@/lib/shared/canonical";
import { percentOfTotal } from "@/lib/shared/dashboard-presentation";

export const metadata = { title: "รายงานปริมาณการจ่ายยา" };
export const dynamic = "force-dynamic";

/**
 * The aggregated list is sent to the browser in one go so the search box can
 * filter instantly. A รพ.สต. has a few hundred distinct drugs; the cap is a
 * safety net for an all-facility view.
 */
const MAX_ROWS = 3000;

function isoDate(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

/** `types=01,05` -> ["01","05"]; empty means "use the default scope". */
function parseTypes(value: unknown): string[] | null {
  const raw = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^\d{1,2}$/.test(item));
  return list.length ? list : null;
}

const METRIC_TONES = {
  blue: {
    card: "border-blue-100 from-blue-50/95 via-white to-white",
    icon: "from-blue-400 to-blue-600 text-white shadow-blue-200/70",
    detail: "text-blue-600",
  },
  green: {
    card: "border-emerald-100 from-emerald-50/90 via-white to-white",
    icon: "from-emerald-400 to-teal-600 text-white shadow-emerald-200/70",
    detail: "text-emerald-600",
  },
  violet: {
    card: "border-violet-100 from-violet-50/95 via-white to-white",
    icon: "from-violet-400 to-purple-600 text-white shadow-violet-200/70",
    detail: "text-violet-600",
  },
  amber: {
    card: "border-amber-100 from-amber-50/95 via-white to-white",
    icon: "from-amber-400 to-orange-500 text-white shadow-amber-200/70",
    detail: "text-amber-700",
  },
} as const;

function ReportMetric({
  label,
  value,
  unit,
  icon: Icon,
  tone,
  detail,
}: {
  label: string;
  value: number;
  unit: string;
  icon: LucideIcon;
  tone: keyof typeof METRIC_TONES;
  detail: ReactNode;
}) {
  const colors = METRIC_TONES[tone];
  return (
    <section
      className={`min-w-0 overflow-hidden rounded-[14px] border bg-gradient-to-br p-3.5 shadow-[0_6px_20px_rgba(31,78,112,0.055)] ${colors.card}`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-md ${colors.icon}`}
        >
          <Icon aria-hidden className="size-[18px]" strokeWidth={2.1} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-ink-soft">{label}</p>
          <p className="mt-1 whitespace-nowrap text-[24px] font-bold leading-none tracking-[-0.025em] text-ink numeric xl:text-[26px]">
            {formatNumber(value)}
            <span className="ml-1.5 text-xs font-medium tracking-normal text-muted">{unit}</span>
          </p>
        </div>
      </div>
      <div className={`mt-2 text-[11px] font-medium leading-snug ${colors.detail}`}>{detail}</div>
    </section>
  );
}

function ReportPanel({
  title,
  description,
  icon: Icon,
  iconClassName,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  iconClassName: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`min-w-0 overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.065)] ${className}`}
    >
      <div className="flex min-h-[56px] items-center gap-2.5 border-b border-slate-100 px-4 py-2.5 sm:px-5">
        <div className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] ${iconClassName}`}>
          <Icon aria-hidden className="size-4" strokeWidth={2.1} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export default async function DrugUsageReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const isSuper = user.role === "SUPER_ADMIN";

  // Same default as the dashboard: the current fiscal year up to today.
  const fallback = currentFiscalRange();
  const fyParam = Number(params.fy);
  const picked = Number.isInteger(fyParam) && fyParam > 2400 ? buildFiscalYear(fyParam) : null;
  const from = picked ? picked.start : isoDate(params.from, fallback.from);
  const to = picked ? picked.end : isoDate(params.to, fallback.to);
  const fiscal = fiscalYearOf(new Date(`${from}T00:00:00`));
  const search = typeof params.q === "string" && params.q.trim() ? params.q.trim() : null;
  const requestedFacility = typeof params.facility === "string" ? params.facility : null;

  // Category scope is decided server-side: USER/ADMIN can never widen past
  // the medicine categories (01, 10); SUPER_ADMIN starts there and may add more.
  const typeScope = resolveDrugTypeScope(user, parseTypes(params.types));

  let scope;
  try {
    scope = resolveFacilityScope(user, requestedFacility);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return (
        <>
          <PageHeader title="รายงานปริมาณการจ่ายยา" />
          <ErrorState
            title="ไม่มีสิทธิ์เข้าถึงข้อมูลของสถานบริการนี้"
            detail="บัญชีของคุณเห็นได้เฉพาะข้อมูลสถานบริการของตนเองเท่านั้น"
          />
        </>
      );
    }
    throw error;
  }

  const filters = {
    facilityIds: scope.facilityIds,
    from,
    to,
    drugTypes: typeScope.types,
    search,
  };

  const [summary, byType, table, trend, availableTypes, facilityOptions] = await Promise.all([
    getUsageSummary(filters),
    getUsageByDrugType(filters),
    getUsageByDrug(filters, { page: 1, pageSize: MAX_ROWS }),
    getUsageTrend(filters, "day"),
    typeScope.canWiden ? getAvailableDrugTypes(scope.facilityIds) : Promise.resolve([]),
    isSuper ? listFacilityOptions(null) : Promise.resolve([]),
  ]);

  // Checkbox list: the two medicine categories always, plus whatever else the
  // facility actually has (SUPER_ADMIN only).
  const selectableTypes = [
    ...PRIMARY_DRUG_TYPES,
    ...availableTypes
      .map((t) => t.drugType)
      .filter((type) => !(PRIMARY_DRUG_TYPES as readonly string[]).includes(type)),
  ];

  const typesParam = typeScope.types.join(",");
  const queryParams = {
    from,
    to,
    types: typesParam,
    q: search ?? undefined,
    facility: requestedFacility ?? undefined,
  };

  const exportHref = `/api/reports/drug-usage/export?${new URLSearchParams(
    Object.entries(queryParams).filter(([, value]) => value) as [string, string][],
  ).toString()}`;

  return (
    <div className="overflow-x-hidden">
      <header className="mb-3 flex flex-col gap-3 px-0.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-slate-900 sm:text-[28px]">
            รายงานปริมาณการจ่ายยา
          </h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-slate-500">
            {fiscal.label} · ข้อมูล {from} ถึง {to} · ตามสถานบริการและหมวดยาที่ได้รับอนุญาต
          </p>
        </div>
        <Link
          href={exportHref}
          className={`${buttonClass("secondary", "sm")} w-full justify-center border-slate-200 bg-white shadow-sm sm:w-auto`}
        >
          <Download aria-hidden className="size-4" />
          ส่งออก CSV
        </Link>
      </header>

      <DrugUsageSearchProvider initialQuery={search ?? ""}>
        <section className="relative z-20 mb-3 rounded-[14px] border border-slate-200/85 bg-white shadow-[0_6px_22px_rgba(31,78,112,0.055)]">
          <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-2.5 sm:px-5">
            <div className="flex size-8 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">
              <Layers3 aria-hidden className="size-4" strokeWidth={2.1} />
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-ink">เลือกช่วงข้อมูลและเงื่อนไขการแสดงผล</h2>
              <p className="text-[11px] text-muted">ตัวกรองใช้กับสรุป ตาราง กราฟ และไฟล์ CSV</p>
            </div>
          </div>
          <form method="get" className="px-4 py-3 no-print sm:px-5">
            <div className="grid w-full gap-2.5 md:grid-cols-2 xl:grid-cols-[1.65fr_0.8fr_1fr_1fr]">
              <div className="min-w-0">
                <span className="mb-1 block text-xs font-semibold text-slate-700">ช่วงวันที่</span>
                <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-[0.8fr_1.1fr_1.1fr]">
                  <select name="fy" defaultValue="" aria-label="ปีงบประมาณ" className={`${inputClass} col-span-2 min-w-0 px-2 text-xs xl:col-span-1`}>
                    <option value="">กำหนดเอง</option>
                    {recentFiscalYears(5).map((year) => (
                      <option key={year.year} value={year.year}>
                        ปีงบ {year.year}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    name="from"
                    defaultValue={from}
                    aria-label="ตั้งแต่วันที่"
                    className={`${inputClass} min-w-0 px-2 text-xs`}
                  />
                  <input
                    type="date"
                    name="to"
                    defaultValue={to}
                    aria-label="ถึงวันที่"
                    className={`${inputClass} min-w-0 px-2 text-xs`}
                  />
                </div>
              </div>

              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-semibold text-slate-700">สถานบริการ</span>
                {isSuper ? (
                  <select name="facility" defaultValue={requestedFacility ?? ""} className={inputClass}>
                    <option value="">ทุกสถานบริการ</option>
                    {facilityOptions.map((facility) => (
                      <option key={facility.id} value={facility.id}>
                        {facility.code} · {facility.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`${inputClass} flex items-center bg-slate-50 text-muted`}>
                    สถานบริการตามสิทธิ์บัญชี
                  </span>
                )}
              </label>

              <DrugTypeMultiSelect
                options={selectableTypes}
                selected={typeScope.types}
                primaryTypes={[...PRIMARY_DRUG_TYPES]}
              />

              <DrugUsageSearchInput />
            </div>

            <div className="mt-2.5 flex items-center justify-end gap-1.5 border-t border-slate-100 pt-2.5">
              <Link href="/reports/drug-usage" className={buttonClass("ghost", "sm")}>
                <RotateCcw aria-hidden className="size-4" />
                ค่าเริ่มต้น
              </Link>
              <button type="submit" className={buttonClass("primary", "sm")}>
                <Search aria-hidden className="size-4" />
                แสดงรายงาน
              </button>
            </div>
          </form>
        </section>

      <section className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="รายการจ่ายยา"
          value={summary.dispensingRows}
          unit="รายการ"
          icon={ListChecks}
          tone="blue"
          detail="จำนวนครั้งที่มีการจ่ายในช่วงที่เลือก"
        />
        <ReportMetric
          label="จำนวนรายการยา"
          value={summary.distinctDrugs}
          unit="รายการ"
          icon={Pill}
          tone="green"
          detail="รหัสยาที่มีการจ่ายจริง"
        />
        <ReportMetric
          label="ปริมาณรวม"
          value={summary.totalQuantity}
          unit="หน่วย"
          icon={Boxes}
          tone="violet"
          detail="รวมทุกหน่วยตามข้อมูลต้นทาง"
        />
        <ReportMetric
          label="หมวดยาที่แสดง"
          value={byType.length}
          unit="หมวด"
          icon={Layers3}
          tone="amber"
          detail="ตามตัวกรองและสิทธิ์ปัจจุบัน"
        />
      </section>

        <DrugUsageReportViews
          dateContext={`ข้อมูล ${from} ถึง ${to}`}
          listView={
            <DrugUsageTable
              rows={table.rows}
              linkParams={new URLSearchParams(
                Object.entries({
                  from,
                  to,
                  ...(requestedFacility ? { facility: requestedFacility } : {}),
                }),
              ).toString()}
            />
          }
          categoryView={
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {byType.length ? (
                byType.map((row, index) => {
                  const percentage = percentOfTotal(row.totalQuantity, summary.totalQuantity);
                  const isBlue = index % 2 === 0;
                  return (
                    <div key={row.drugType ?? "unknown"}>
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={`flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                              isBlue ? "bg-blue-50 text-blue-600" : "bg-emerald-50 text-emerald-600"
                            }`}
                          >
                            {row.drugType ?? "-"}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-semibold text-ink">
                              {drugTypeLabel(row.drugType)}
                            </p>
                            <p className="text-[11px] text-muted">
                              {formatNumber(row.distinctDrugs)} รายการยา · {formatNumber(row.dispensingRows)} ครั้ง
                            </p>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold text-ink numeric">{formatNumber(row.totalQuantity)}</p>
                          <p className="text-[11px] font-semibold text-muted numeric">
                            {percentage.toLocaleString("th-TH")}%
                          </p>
                        </div>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${isBlue ? "bg-blue-500" : "bg-emerald-500"}`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="py-12 text-center text-sm text-muted">ไม่มีข้อมูลในช่วงเวลาที่เลือก</p>
              )}
            </div>
          }
        />

        <ReportPanel
          title="แนวโน้มการจ่ายยา"
          description={`ข้อมูลประกอบ · ปริมาณใช้รายวัน ${from} ถึง ${to}`}
          icon={ChartNoAxesCombined}
          iconClassName="bg-blue-50 text-blue-600"
          className="mt-3"
        >
          <div className="p-3 sm:p-4">
            {trend.length ? (
              <TrendChart data={trend} height={230} />
            ) : (
              <p className="py-12 text-center text-sm text-muted">ไม่มีข้อมูลในช่วงเวลาที่เลือก</p>
            )}
          </div>
        </ReportPanel>
      </DrugUsageSearchProvider>
    </div>
  );
}
