import Link from "next/link";

import {
  Activity,
  ArrowUpRight,
  Boxes,
  Building2,
  ChartNoAxesCombined,
  ListChecks,
  Pill,
  Server,
  Trophy,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { DashboardTrendChart } from "@/components/ui/dashboard-trend-chart";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
import { FacilityDrilldown } from "@/components/ui/facility-drilldown";
import { StatusBadge, formatNumber, relativeTime } from "@/components/ui/primitives";
import { requireUser, resolveDrugTypeScope, resolveFacilityScope } from "@/lib/auth/rbac";
import { buildFiscalYear, currentFiscalRange, fiscalYearOf } from "@/lib/fiscal-year";
import { getFleetSummary, listAgents } from "@/lib/services/monitoring";
import {
  getUsageByDrug,
  getUsageByDrugType,
  getUsageByFacility,
  getUsageByFacilityAndDrug,
  getUsageSummary,
  getUsageTrend,
} from "@/lib/services/reports";
import { PRIMARY_DRUG_TYPES, drugTypeLabel } from "@/lib/shared/canonical";
import { percentOfTotal } from "@/lib/shared/dashboard-presentation";

export const metadata = { title: "แดชบอร์ด" };
export const dynamic = "force-dynamic";

function isoDate(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

const KPI_TONES = {
  blue: {
    card: "from-blue-50/95 via-white to-white border-blue-100",
    icon: "bg-gradient-to-br from-blue-400 to-blue-600 text-white shadow-blue-200/70",
    accent: "text-blue-600",
  },
  teal: {
    card: "from-emerald-50/90 via-white to-white border-emerald-100",
    icon: "bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-emerald-200/70",
    accent: "text-emerald-600",
  },
  violet: {
    card: "from-violet-50/95 via-white to-white border-violet-100",
    icon: "bg-gradient-to-br from-violet-400 to-purple-600 text-white shadow-violet-200/70",
    accent: "text-violet-600",
  },
  cyan: {
    card: "from-cyan-50/95 via-white to-white border-cyan-100",
    icon: "bg-gradient-to-br from-cyan-400 to-teal-500 text-white shadow-cyan-200/70",
    accent: "text-cyan-600",
  },
} as const;

function DashboardMetric({
  label,
  value,
  unit,
  icon: Icon,
  tone,
  detail,
}: {
  label: string;
  value: string | number;
  unit: string;
  icon: LucideIcon;
  tone: keyof typeof KPI_TONES;
  detail: ReactNode;
}) {
  const colors = KPI_TONES[tone];
  return (
    <section
      className={`relative min-w-0 overflow-hidden rounded-[16px] border bg-gradient-to-br p-4 shadow-[0_8px_26px_rgba(31,78,112,0.07)] sm:p-5 ${colors.card}`}
    >
      <div className="flex items-start gap-3.5">
        <div className={`flex size-11 shrink-0 items-center justify-center rounded-[13px] shadow-lg ${colors.icon}`}>
          <Icon aria-hidden className="size-5" strokeWidth={2.1} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink-soft">{label}</p>
          <p className="mt-1.5 whitespace-nowrap text-[28px] font-bold leading-none tracking-[-0.025em] text-ink numeric xl:text-[30px]">
            {typeof value === "number" ? formatNumber(value) : value}
            <span className="ml-1.5 text-xs font-medium tracking-normal text-muted">{unit}</span>
          </p>
        </div>
      </div>
      <div className={`mt-3 flex items-center gap-1.5 text-xs font-medium ${colors.accent}`}>{detail}</div>
    </section>
  );
}

function DashboardPanel({
  title,
  description,
  icon: Icon,
  iconClassName,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  iconClassName: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.065)] ${className}`}>
      <div className="flex min-h-[64px] flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-[11px] ${iconClassName}`}>
            <Icon aria-hidden className="size-[18px]" strokeWidth={2.1} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 truncate text-xs text-muted">{description}</p> : null}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const scope = resolveFacilityScope(user);
  const typeScope = resolveDrugTypeScope(user);
  const primaryTypeLabels = PRIMARY_DRUG_TYPES.map((type) => drugTypeLabel(type)).join("และ");
  const fallback = currentFiscalRange();
  const fyParam = Number(params.fy);
  const picked = Number.isInteger(fyParam) && fyParam > 2400 ? buildFiscalYear(fyParam) : null;
  const range = picked
    ? { from: picked.start, to: picked.end }
    : { from: isoDate(params.from, fallback.from), to: isoDate(params.to, fallback.to) };
  const fiscal = fiscalYearOf(new Date(`${range.from}T00:00:00`));

  const filters = {
    facilityIds: scope.facilityIds,
    from: range.from,
    to: range.to,
    drugTypes: typeScope.types,
  };
  const isSuper = user.role === "SUPER_ADMIN";

  const [summary, fleet, trend, topDrugs, agentRows, byFacility, byType, facilityDrugs] =
    await Promise.all([
      getUsageSummary(filters),
      getFleetSummary(scope.facilityIds),
      getUsageTrend(filters, "day"),
      getUsageByDrug(filters, { page: 1, pageSize: 10 }, "quantity"),
      listAgents(scope.facilityIds),
      getUsageByFacility(filters),
      getUsageByDrugType(filters),
      getUsageByFacilityAndDrug(filters),
    ]);

  const linkParams = new URLSearchParams({ from: range.from, to: range.to }).toString();
  const largestDrugQuantity = Math.max(1, ...topDrugs.rows.map((row) => row.totalQuantity));

  return (
    <div className="relative overflow-x-hidden">
      <div className="pointer-events-none absolute -left-8 -right-8 -top-8 h-48 bg-[radial-gradient(circle_at_top_left,rgba(71,165,255,0.11),transparent_55%),radial-gradient(circle_at_top_right,rgba(20,184,166,0.09),transparent_48%)]" />

      <section className="relative mb-5 grid gap-4 xl:grid-cols-[minmax(0,0.65fr)_minmax(700px,1.35fr)] xl:items-start">
        <div className="px-1 py-2 sm:py-3">
          <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50/80 px-3 py-1 text-[11px] font-semibold text-blue-700">
            <Activity aria-hidden className="size-3.5" />
            ข้อมูลการใช้ยาจากระบบ JHCIS
          </p>
          <h1 className="text-[27px] font-bold tracking-[-0.025em] text-slate-900 sm:text-[32px]">
            {isSuper ? "ภาพรวมการใช้ยาทั้งอำเภอ" : "ภาพรวมการใช้ยา"}
          </h1>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-slate-500 sm:text-sm">
            สรุปข้อมูลการจ่ายยาและเวชภัณฑ์ในขอบเขตที่ได้รับอนุญาต · เฉพาะ{primaryTypeLabels}
          </p>
        </div>

        <div className="overflow-hidden rounded-[16px] border border-slate-200/85 bg-white/95 shadow-[0_8px_28px_rgba(31,78,112,0.065)] backdrop-blur-sm [&_form]:bg-transparent [&_form>div:first-of-type]:items-start">
          <DateRangeFilter from={range.from} to={range.to} fiscal={fiscal} basePath="/dashboard" />
        </div>
      </section>

      <section className="relative grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DashboardMetric label="รายการจ่ายยา" value={summary.dispensingRows} unit="รายการ" icon={ListChecks} tone="blue" detail={<><ChartNoAxesCombined aria-hidden className="size-3.5" />ตามช่วงเวลาที่เลือก</>} />
        <DashboardMetric label="จำนวนรายการยา" value={summary.distinctDrugs} unit="รายการ" icon={Pill} tone="teal" detail={<><Pill aria-hidden className="size-3.5" />รหัสยาที่มีการจ่ายจริง</>} />
        <DashboardMetric label="ปริมาณใช้รวม" value={summary.totalQuantity} unit="หน่วย" icon={Boxes} tone="violet" detail={<><Boxes aria-hidden className="size-3.5" />รวมทุกหน่วยตามข้อมูลต้นทาง</>} />
        <DashboardMetric
          label="Agent ออนไลน์"
          value={`${fleet.online}/${fleet.agentsTotal}`}
          unit="เครื่อง"
          icon={Server}
          tone="cyan"
          detail={<><span className={`size-2 rounded-full ${fleet.offline > 0 ? "bg-amber-500" : "bg-emerald-500"}`} />{fleet.lastSyncAt ? `ซิงก์ล่าสุด ${relativeTime(fleet.lastSyncAt)}` : "ยังไม่เคยซิงก์"}</>}
        />
      </section>

      <section className="relative mt-4 grid gap-4 xl:grid-cols-[minmax(0,2.05fr)_minmax(310px,0.95fr)]">
        <DashboardPanel title="แนวโน้มการใช้ยา" description={`ข้อมูลรายวัน · ${range.from} ถึง ${range.to}`} icon={ChartNoAxesCombined} iconClassName="bg-blue-50 text-blue-600">
          <div className="p-3 sm:p-5">
            {trend.length ? <DashboardTrendChart data={trend} height={330} /> : <p className="py-28 text-center text-sm text-muted">ยังไม่มีข้อมูลในช่วงเวลานี้</p>}
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="สรุปตามหมวดยา"
          description="สัดส่วนจากปริมาณใช้รวม"
          icon={Boxes}
          iconClassName="bg-violet-50 text-violet-600"
          action={<Link href="/reports/drug-usage" className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-100">ดูทั้งหมด <ArrowUpRight aria-hidden className="size-3.5" /></Link>}
        >
          <div className="space-y-5 px-4 py-5 sm:px-5">
            {byType.length ? byType.map((row, index) => {
              const percentage = percentOfTotal(row.totalQuantity, summary.totalQuantity);
              const barColor = index % 2 === 0 ? "bg-blue-500" : "bg-emerald-500";
              const badgeColor = index % 2 === 0 ? "bg-blue-50 text-blue-600" : "bg-emerald-50 text-emerald-600";
              return (
                <div key={row.drugType ?? "unknown"}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${badgeColor}`}>{row.drugType ?? "-"}</span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-ink">{drugTypeLabel(row.drugType)}</p>
                        <p className="text-[11px] text-muted">{formatNumber(row.distinctDrugs)} รายการยา</p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-ink numeric">{formatNumber(row.totalQuantity)}</p>
                      <p className="text-[11px] font-semibold text-muted numeric">{percentage.toLocaleString("th-TH")}%</p>
                    </div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${barColor}`} style={{ width: `${percentage}%` }} /></div>
                </div>
              );
            }) : <p className="py-16 text-center text-sm text-muted">ยังไม่มีข้อมูลหมวดยา</p>}
            <div className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-relaxed text-slate-500">แสดงเฉพาะ {primaryTypeLabels} ตามสิทธิ์การดูรายงานปัจจุบัน</div>
          </div>
        </DashboardPanel>
      </section>

      <section className="relative mt-4 grid gap-4 xl:grid-cols-3">
        <DashboardPanel title="ยาที่ใช้มากที่สุด 10 อันดับ" description="เรียงตามปริมาณใช้รวม" icon={Trophy} iconClassName="bg-amber-50 text-amber-600" action={<Link href="/reports/drug-usage" className="text-xs font-semibold text-blue-600 hover:text-blue-700">ดูทั้งหมด</Link>}>
          <div className="divide-y divide-slate-100 px-4 py-1">
            {topDrugs.rows.map((row, index) => (
              <div key={row.drugCode} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5">
                <span className={`flex size-6 items-center justify-center rounded-full text-[11px] font-bold ${index < 3 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{index + 1}</span>
                <div className="min-w-0">
                  <Link href={`/reports/drug-usage/${encodeURIComponent(row.drugCode)}?${linkParams}`} className="block truncate text-[12.5px] font-semibold text-ink hover:text-blue-600">{row.drugName}</Link>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-600" style={{ width: `${percentOfTotal(row.totalQuantity, largestDrugQuantity)}%` }} /></div>
                </div>
                <p className="text-right text-xs font-bold text-ink numeric">{formatNumber(row.totalQuantity)}<span className="ml-1 font-normal text-muted">{row.unit ?? ""}</span></p>
              </div>
            ))}
            {!topDrugs.rows.length ? <p className="py-14 text-center text-sm text-muted">ยังไม่มีข้อมูล</p> : null}
          </div>
        </DashboardPanel>

        <DashboardPanel title="สรุปตามสถานบริการ" description="เรียงตามปริมาณใช้รวม" icon={Building2} iconClassName="bg-blue-50 text-blue-600">
          <div>
            <table className="w-full table-fixed text-[12px]">
              <colgroup><col className="w-[55%]" /><col className="w-[20%]" /><col className="w-[25%]" /></colgroup>
              <thead className="bg-slate-50 text-left text-[11px] font-semibold text-slate-500"><tr><th className="px-4 py-2.5">สถานบริการ</th><th className="px-2 py-2.5 text-right">ครั้งที่จ่าย</th><th className="px-4 py-2.5 text-right">ปริมาณ</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {byFacility.slice(0, 10).map((row) => <tr key={row.facilityId} className="hover:bg-blue-50/35"><td className="max-w-[180px] px-4 py-2.5"><p className="truncate font-semibold text-ink">{row.facilityName}</p><p className="mt-0.5 text-[10.5px] text-muted">{row.facilityCode}</p></td><td className="px-2 py-2.5 text-right text-ink-soft numeric">{formatNumber(row.dispensingRows)}</td><td className="px-4 py-2.5 text-right font-bold text-ink numeric">{formatNumber(row.totalQuantity)}</td></tr>)}
              </tbody>
            </table>
            {!byFacility.length ? <p className="py-14 text-center text-sm text-muted">ยังไม่มีข้อมูล</p> : null}
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="สถานะ Agent"
          description="การเชื่อมข้อมูลจากสถานบริการ"
          icon={Server}
          iconClassName="bg-cyan-50 text-cyan-600"
          action={isSuper ? <Link href="/admin/monitoring" className="text-xs font-semibold text-blue-600 hover:text-blue-700">ดูทั้งหมด</Link> : null}
        >
          <div>
            <table className="w-full table-fixed text-[12px]">
              <colgroup><col className="w-[46%]" /><col className="w-[24%]" /><col className="w-[30%]" /></colgroup>
              <thead className="bg-slate-50 text-left text-[11px] font-semibold text-slate-500"><tr><th className="px-4 py-2.5">Agent</th><th className="px-2 py-2.5">สถานะ</th><th className="px-4 py-2.5 text-right">ซิงก์ล่าสุด</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {agentRows.slice(0, 10).map((row) => <tr key={row.id} className="hover:bg-cyan-50/35"><td className="max-w-[165px] px-4 py-2.5"><p className="truncate font-semibold text-ink">{row.name}</p><p className="mt-0.5 truncate text-[10.5px] text-muted">{isSuper ? row.facilityCode : row.hostname ?? "-"}</p></td><td className="px-2 py-2.5"><StatusBadge status={row.effectiveStatus} /></td><td className="px-4 py-2.5 text-right text-[11px] text-muted">{relativeTime(row.lastSuccessfulSyncAt)}</td></tr>)}
              </tbody>
            </table>
            {!agentRows.length ? <p className="py-14 text-center text-sm text-muted">ยังไม่มี Agent</p> : null}
          </div>
        </DashboardPanel>
      </section>

      <section className="relative mt-5">
        <div className="mb-3 px-1"><h2 className="text-[17px] font-bold text-ink">รายละเอียดตามสถานบริการ</h2><p className="mt-0.5 text-[13px] text-muted">เลือกสถานบริการเพื่อดูรายการยาที่จ่ายทั้งหมด</p></div>
        <FacilityDrilldown facilities={byFacility} drugs={facilityDrugs} linkParams={linkParams} initialFacilityId={scope.single} />
      </section>
    </div>
  );
}
