import Link from "next/link";

import { RankingChart, TrendChart } from "@/components/ui/charts";
import { DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatNumber,
  relativeTime,
} from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth/rbac";
import { resolveFacilityScope } from "@/lib/auth/rbac";
import { getFleetSummary, listAgents } from "@/lib/services/monitoring";
import {
  getUsageByDrug,
  getUsageByFacility,
  getUsageSummary,
  getUsageTrend,
} from "@/lib/services/reports";
import { drugTypeLabel } from "@/lib/shared/canonical";

export const metadata = { title: "แดชบอร์ด" };
export const dynamic = "force-dynamic";

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default async function DashboardPage() {
  const user = await requireUser();
  const scope = resolveFacilityScope(user);
  const range = defaultRange();
  const filters = { facilityIds: scope.facilityIds, from: range.from, to: range.to };
  const isSuper = user.role === "SUPER_ADMIN";

  const [summary, fleet, trend, topDrugs, agentRows, byFacility] = await Promise.all([
    getUsageSummary(filters),
    getFleetSummary(scope.facilityIds),
    getUsageTrend(filters, "day"),
    getUsageByDrug(filters, { page: 1, pageSize: 10 }),
    listAgents(scope.facilityIds),
    isSuper ? getUsageByFacility(filters) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title={isSuper ? "ภาพรวมทั้งอำเภอ" : "ภาพรวมสถานบริการ"}
        subtitle={`ข้อมูลการจ่ายยาระหว่าง ${range.from} ถึง ${range.to}`}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="รายการจ่ายยา" value={summary.dispensingRows} unit="รายการ" />
        <StatCard label="จำนวนรายการยา" value={summary.distinctDrugs} unit="รายการ" />
        <StatCard label="ปริมาณรวม" value={summary.totalQuantity} unit="หน่วย" />
        <StatCard
          label="Agent ออนไลน์"
          value={`${fleet.online}/${fleet.agentsTotal}`}
          tone={fleet.offline > 0 ? "warn" : "ok"}
          hint={
            fleet.lastSyncAt ? `ซิงก์ล่าสุด ${relativeTime(fleet.lastSyncAt)}` : "ยังไม่เคยซิงก์"
          }
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
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

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card
          title="ยาที่มีการจ่ายสูงสุด"
          description="เรียงตามปริมาณรวม"
          actions={
            <Link href="/reports/drug-usage" className="text-xs font-medium text-brand-700 hover:underline">
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
                  <Link
                    href={`/reports/drug-usage/${encodeURIComponent(row.drugCode)}`}
                    className="font-medium text-ink hover:text-brand-700 hover:underline"
                  >
                    {row.drugName}
                    <span className="block text-xs font-normal text-muted">{row.drugCode}</span>
                  </Link>
                ),
              },
              {
                key: "type",
                header: "ประเภท",
                render: (row) => <span className="text-xs text-muted">{drugTypeLabel(row.drugType)}</span>,
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

        {isSuper ? (
          <Card title="ปริมาณการจ่ายยาแยกตามสถานบริการ" description="เปรียบเทียบระหว่าง รพ.สต.">
            <DataTable
              rowKey={(row) => row.facilityId}
              rows={byFacility}
              emptyTitle="ยังไม่มีข้อมูล"
              columns={[
                {
                  key: "facility",
                  header: "สถานบริการ",
                  render: (row) => (
                    <>
                      <span className="font-medium text-ink">{row.facilityName}</span>
                      <span className="block text-xs text-muted">{row.facilityCode}</span>
                    </>
                  ),
                },
                {
                  key: "drugs",
                  header: "รายการยา",
                  align: "right",
                  render: (row) => formatNumber(row.distinctDrugs),
                },
                {
                  key: "qty",
                  header: "ปริมาณรวม",
                  align: "right",
                  render: (row) => formatNumber(row.totalQuantity),
                },
              ]}
            />
          </Card>
        ) : (
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
                      <span className="block text-xs text-muted">{row.hostname ?? "-"}</span>
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
                    <span className="text-xs text-muted">{relativeTime(row.lastSuccessfulSyncAt)}</span>
                  ),
                },
              ]}
            />
          </Card>
        )}
      </div>
    </>
  );
}
