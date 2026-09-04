import Link from "next/link";

import { Boxes, ListChecks, Pill, Server } from "lucide-react";

import { RankingChart, TrendChart } from "@/components/ui/charts";
import { CellMeta, DataTable } from "@/components/ui/data-table";
import { FacilityDrilldown } from "@/components/ui/facility-drilldown";
import {
  Card,
  PageHeader,
  Section,
  StatCard,
  StatusBadge,
  formatNumber,
  relativeTime,
} from "@/components/ui/primitives";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
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
import { drugTypeLabel } from "@/lib/shared/canonical";

export const metadata = { title: "แดชบอร์ด" };
export const dynamic = "force-dynamic";

function isoDate(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const scope = resolveFacilityScope(user);
  // The dashboard always shows the medicine categories only (01, 05, 10) so the
  // headline totals mean the same thing for every role.
  const typeScope = resolveDrugTypeScope(user);
  // Default window is the current fiscal year (1 ต.ค. - วันนี้); picking a
  // fiscal year overrides the two date fields.
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
      // the ranking is about volume, so it is ordered by quantity, not by name
      getUsageByDrug(filters, { page: 1, pageSize: 10 }, "quantity"),
      listAgents(scope.facilityIds),
      getUsageByFacility(filters),
      getUsageByDrugType(filters),
      getUsageByFacilityAndDrug(filters),
    ]);

  // Links out of the drill-down keep the window the dashboard is showing.
  const linkParams = new URLSearchParams({ from: range.from, to: range.to }).toString();

  return (
    <>
      <PageHeader
        title={isSuper ? "ภาพรวมทั้งอำเภอ" : "ภาพรวมสถานบริการ"}
        subtitle={`${fiscal.label} · ข้อมูล ${range.from} ถึง ${range.to} · เฉพาะยาแผนปัจจุบันและยาสมุนไพร`}
      />

      <div className="mb-5 rounded-[10px] border border-line bg-surface no-print">
        <DateRangeFilter from={range.from} to={range.to} fiscal={fiscal} basePath="/dashboard" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="รายการจ่ายยา"
          value={summary.dispensingRows}
          unit="รายการ"
          icon={ListChecks}
        />
        <StatCard label="จำนวนรายการยา" value={summary.distinctDrugs} unit="รายการ" icon={Pill} />
        <StatCard label="ปริมาณรวม" value={summary.totalQuantity} unit="หน่วย" icon={Boxes} />
        <StatCard
          label="Agent ออนไลน์"
          value={`${fleet.online}/${fleet.agentsTotal}`}
          tone={fleet.offline > 0 ? "warn" : "ok"}
          icon={Server}
          accent
          hint={
            fleet.lastSyncAt ? `ซิงก์ล่าสุด ${relativeTime(fleet.lastSyncAt)}` : "ยังไม่เคยซิงก์"
          }
        />
      </div>

      <Section
        title="แยกตามหมวดยา"
        description="ยาแผนปัจจุบันและยาสมุนไพร ในช่วงเวลาที่เลือก"
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {byType.map((row) => (
            <StatCard
              key={row.drugType ?? "unknown"}
              label={drugTypeLabel(row.drugType)}
              value={row.totalQuantity}
              unit="หน่วย"
              hint={`${row.distinctDrugs.toLocaleString("th-TH")} รายการยา · จ่าย ${row.dispensingRows.toLocaleString("th-TH")} ครั้ง`}
            />
          ))}
        </div>
      </Section>

      <div className="mt-8 grid gap-5 xl:grid-cols-3">
        <Card
          title="แนวโน้มปริมาณการจ่ายยา"
          description="รวมทุกประเภทยา รายวัน"
          className="xl:col-span-2"
        >
          <div className="p-4">
            {trend.length ? (
              <TrendChart data={trend} />
            ) : (
              <p className="py-16 text-center text-sm text-muted">ยังไม่มีข้อมูลในช่วงเวลานี้</p>
            )}
          </div>
        </Card>

        <Card title="ยาที่จ่ายมากที่สุด" description="10 อันดับแรกตามปริมาณ">
          <div className="p-4">
            {topDrugs.rows.length ? (
              <RankingChart
                data={topDrugs.rows.map((r) => ({
                  label: r.drugName.length > 22 ? `${r.drugName.slice(0, 22)}…` : r.drugName,
                  value: r.totalQuantity,
                }))}
              />
            ) : (
              <p className="py-16 text-center text-sm text-muted">ยังไม่มีข้อมูล</p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-5">
        <FacilityDrilldown
          facilities={byFacility}
          drugs={facilityDrugs}
          linkParams={linkParams}
          initialFacilityId={scope.single}
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card
          title="ยาที่มีการจ่ายสูงสุด"
          description="10 อันดับแรกตามปริมาณรวมทุกสถานบริการในสิทธิ์"
          actions={
            <Link
              href="/reports/drug-usage"
              className="text-[13px] font-medium text-brand transition-colors duration-150 hover:text-brand-hover"
            >
              ดูรายงานทั้งหมด
            </Link>
          }
        >
          <DataTable
            rowKey={(row) => row.drugCode}
            rows={topDrugs.rows}
            emptyTitle="ยังไม่มีข้อมูลการจ่ายยา"
            emptyDescription="ข้อมูลจะปรากฏหลังจาก Agent ซิงก์ข้อมูลจาก JHCIS สำเร็จ"
            columns={[
              {
                key: "drug",
                header: "ยา",
                render: (row) => (
                  <>
                    <Link
                      href={`/reports/drug-usage/${encodeURIComponent(row.drugCode)}?${linkParams}`}
                      className="font-medium text-ink transition-colors duration-150 hover:text-brand"
                    >
                      {row.drugName}
                    </Link>
                    <CellMeta>{row.drugCode}</CellMeta>
                  </>
                ),
              },
              {
                key: "type",
                header: "ประเภท",
                hideBelow: "sm",
                render: (row) => (
                  <span className="text-xs text-muted">{drugTypeLabel(row.drugType)}</span>
                ),
              },
              {
                key: "qty",
                header: "ปริมาณ",
                align: "right",
                render: (row) => (
                  <>
                    {formatNumber(row.totalQuantity)}
                    <span className="ml-1 text-xs text-muted">{row.unit ?? ""}</span>
                  </>
                ),
              },
            ]}
          />
        </Card>

        <Card title="สถานะ Agent" description="ตัวเชื่อมข้อมูลจาก JHCIS ของสถานบริการ">
          <DataTable
            rowKey={(row) => row.id}
            rows={agentRows}
            emptyTitle="ยังไม่มี Agent"
            emptyDescription="ติดต่อผู้ดูแลระบบส่วนกลางเพื่อสร้างและติดตั้ง Agent"
            columns={[
              {
                key: "name",
                header: "Agent",
                render: (row) => (
                  <>
                    <span className="font-medium text-ink">{row.name}</span>
                    <CellMeta>
                      {isSuper ? `${row.facilityCode} · ` : ""}
                      {row.hostname ?? "-"}
                    </CellMeta>
                  </>
                ),
              },
              {
                key: "status",
                header: "สถานะ",
                render: (row) => <StatusBadge status={row.effectiveStatus} />,
              },
              {
                key: "sync",
                header: "ซิงก์ล่าสุด",
                align: "right",
                render: (row) => (
                  <span className="text-xs text-muted">
                    {relativeTime(row.lastSuccessfulSyncAt)}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
