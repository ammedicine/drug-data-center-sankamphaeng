import Link from "next/link";
import { notFound } from "next/navigation";

import { TrendChart } from "@/components/ui/charts";
import { DataTable } from "@/components/ui/data-table";
import {
  Card,
  PageHeader,
  StatCard,
  StatusBadge,
  formatNumber,
} from "@/components/ui/primitives";
import { requireUser, resolveDrugTypeScope, resolveFacilityScope } from "@/lib/auth/rbac";
import {
  getDrugDetail,
  getUsageByFacility,
  getUsageSummary,
  getUsageTrend,
} from "@/lib/services/reports";
import { currentFiscalRange, fiscalYearOf } from "@/lib/fiscal-year";
import { drugTypeLabel } from "@/lib/shared/canonical";

export const dynamic = "force-dynamic";

function isoDate(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export default async function DrugDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ drugCode: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { drugCode: rawCode } = await params;
  const query = await searchParams;
  const drugCode = decodeURIComponent(rawCode);

  const user = await requireUser();
  const isSuper = user.role === "SUPER_ADMIN";
  const scope = resolveFacilityScope(
    user,
    typeof query.facility === "string" ? query.facility : null,
  );

  const fallback = currentFiscalRange();
  const from = isoDate(query.from, fallback.from);
  const to = isoDate(query.to, fallback.to);
  const fiscal = fiscalYearOf(new Date(`${from}T00:00:00`));

  const typeScope = resolveDrugTypeScope(user);
  const filters = {
    facilityIds: scope.facilityIds,
    from,
    to,
    drugCode,
    drugTypes: typeScope.types,
  };

  const [detail, summary, daily, byFacility] = await Promise.all([
    getDrugDetail(scope.facilityIds, drugCode),
    getUsageSummary(filters),
    getUsageTrend(filters, "day"),
    isSuper ? getUsageByFacility(filters) : Promise.resolve([]),
  ]);

  // A code with no master row and no usage in scope is genuinely not visible to
  // this user - do not leak whether it exists elsewhere.
  if (!detail && summary.dispensingRows === 0) notFound();

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/reports/drug-usage" className="hover:underline">
            ← กลับไปรายงานปริมาณการจ่ายยา
          </Link>
        }
        title={detail?.drugName ?? drugCode}
        subtitle={`รหัสยา ${drugCode} · ${drugTypeLabel(detail?.drugType)} · ${fiscal.label} · ข้อมูล ${from} ถึง ${to}`}
        actions={
          // A code with no master row is "ไม่ทราบสถานะ", never "ใช้งาน".
          <StatusBadge
            status={
              detail?.drugFlag === "2" ? "INACTIVE" : detail?.drugFlag ? "ACTIVE" : "UNKNOWN"
            }
          />
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="ครั้งที่จ่าย" value={summary.dispensingRows} unit="รายการ" />
        <StatCard label="ปริมาณรวม" value={summary.totalQuantity} unit={detail?.unit ?? "หน่วย"} />
        <StatCard
          label="เฉลี่ยต่อครั้ง"
          value={
            summary.dispensingRows
              ? formatNumber(summary.totalQuantity / summary.dispensingRows, 2)
              : "-"
          }
        />
        <StatCard label="ชื่อสามัญ" value={detail?.genericName ?? "-"} />
      </div>

      <Card title="แนวโน้มการจ่ายยา" className="mt-6">
        <div className="p-4">
          {daily.length ? (
            <TrendChart data={daily} />
          ) : (
            <p className="py-12 text-center text-sm text-muted">ไม่มีข้อมูลในช่วงเวลาที่เลือก</p>
          )}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="ปริมาณการจ่ายรายวัน">
          <DataTable
            rowKey={(row) => row.period}
            rows={[...daily].reverse()}
            emptyTitle="ไม่มีข้อมูล"
            columns={[
              { key: "date", header: "วันที่", render: (row) => row.period },
              {
                key: "rows",
                header: "ครั้งที่จ่าย",
                align: "right",
                render: (row) => formatNumber(row.dispensingRows),
              },
              {
                key: "qty",
                header: "จำนวนจ่าย",
                align: "right",
                render: (row) => formatNumber(row.totalQuantity),
              },
              {
                key: "unit",
                header: "หน่วย",
                render: () => <span className="text-xs text-muted">{detail?.unit ?? "-"}</span>,
              },
            ]}
          />
        </Card>

        {isSuper ? (
          <Card title="แยกตามสถานบริการ" description="เฉพาะผู้ดูแลระบบส่วนกลาง">
            <DataTable
              rowKey={(row) => row.facilityId}
              rows={byFacility}
              emptyTitle="ไม่มีข้อมูล"
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
                  key: "rows",
                  header: "ครั้งที่จ่าย",
                  align: "right",
                  render: (row) => formatNumber(row.dispensingRows),
                },
                {
                  key: "qty",
                  header: "ปริมาณ",
                  align: "right",
                  render: (row) => formatNumber(row.totalQuantity),
                },
              ]}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
