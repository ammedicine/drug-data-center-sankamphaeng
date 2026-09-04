import Link from "next/link";

import { TrendChart } from "@/components/ui/charts";
import { DataTable, Pagination } from "@/components/ui/data-table";
import {
  Button,
  Card,
  ErrorState,
  Field,
  PageHeader,
  StatCard,
  formatNumber,
  inputClass,
} from "@/components/ui/primitives";
import { requireUser, resolveFacilityScope, ForbiddenError } from "@/lib/auth/rbac";
import { listFacilityOptions } from "@/lib/services/facilities";
import {
  getAvailableDrugTypes,
  getUsageByDrug,
  getUsageSummary,
  getUsageTrend,
} from "@/lib/services/reports";
import { drugTypeLabel } from "@/lib/shared/canonical";

export const metadata = { title: "รายงานปริมาณการจ่ายยา" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function isoDate(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export default async function DrugUsageReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const isSuper = user.role === "SUPER_ADMIN";

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);

  const from = isoDate(params.from, monthAgo);
  const to = isoDate(params.to, today);
  const drugType = typeof params.drugType === "string" && params.drugType ? params.drugType : null;
  const search = typeof params.q === "string" && params.q.trim() ? params.q.trim() : null;
  const requestedFacility = typeof params.facility === "string" ? params.facility : null;
  const page = Math.max(1, Number(params.page ?? 1) || 1);

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

  const filters = { facilityIds: scope.facilityIds, from, to, drugType, search };

  const [summary, table, trend, drugTypes, facilityOptions] = await Promise.all([
    getUsageSummary(filters),
    getUsageByDrug(filters, { page, pageSize: PAGE_SIZE }),
    getUsageTrend(filters, from === to ? "day" : "day"),
    getAvailableDrugTypes(scope.facilityIds),
    isSuper ? listFacilityOptions(null) : Promise.resolve([]),
  ]);

  const queryParams = {
    from,
    to,
    drugType: drugType ?? undefined,
    q: search ?? undefined,
    facility: requestedFacility ?? undefined,
  };

  return (
    <>
      <PageHeader
        title="รายงานปริมาณการจ่ายยา"
        subtitle="ข้อมูลการจ่ายยาให้ผู้รับบริการจาก JHCIS ของสถานบริการ"
        actions={
          <Link
            href={`/api/reports/drug-usage/export?${new URLSearchParams(
              Object.entries(queryParams).filter(([, v]) => v) as [string, string][],
            ).toString()}`}
            className="inline-flex items-center rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-canvas"
          >
            ส่งออก CSV
          </Link>
        }
      />

      <Card className="mb-6 no-print">
        <form method="get" className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="ตั้งแต่วันที่">
            <input type="date" name="from" defaultValue={from} className={inputClass} />
          </Field>
          <Field label="ถึงวันที่">
            <input type="date" name="to" defaultValue={to} className={inputClass} />
          </Field>
          <Field label="ประเภทยา">
            <select name="drugType" defaultValue={drugType ?? ""} className={inputClass}>
              <option value="">ทุกประเภท</option>
              {drugTypes.map((t) => (
                <option key={t.drugType} value={t.drugType}>
                  {drugTypeLabel(t.drugType)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ค้นหายา">
            <input
              type="search"
              name="q"
              defaultValue={search ?? ""}
              placeholder="รหัสยา หรือ ชื่อยา"
              className={inputClass}
            />
          </Field>
          {isSuper ? (
            <Field label="สถานบริการ">
              <select name="facility" defaultValue={requestedFacility ?? ""} className={inputClass}>
                <option value="">ทุกสถานบริการ</option>
                {facilityOptions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.code} · {f.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <div className="flex items-end gap-2">
            <Button type="submit">ค้นหา</Button>
            <Link
              href="/reports/drug-usage"
              className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-canvas"
            >
              ล้าง
            </Link>
          </div>
        </form>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="รายการจ่ายยา" value={summary.dispensingRows} unit="รายการ" />
        <StatCard label="จำนวนรายการยา" value={summary.distinctDrugs} unit="รายการ" />
        <StatCard label="ปริมาณรวม" value={summary.totalQuantity} unit="หน่วย" />
        <StatCard label="ประเภทของยา" value={summary.distinctDrugTypes} unit="ประเภท" />
      </div>

      <Card title="แนวโน้มการจ่ายยา" className="mt-6">
        <div className="p-4">
          {trend.length ? (
            <TrendChart data={trend} />
          ) : (
            <p className="py-12 text-center text-sm text-muted">ไม่มีข้อมูลในช่วงเวลาที่เลือก</p>
          )}
        </div>
      </Card>

      <Card
        title="ปริมาณการจ่ายยารายรายการ"
        description={`ช่วงข้อมูล ${from} ถึง ${to}`}
        className="mt-6"
      >
        <DataTable
          rowKey={(row) => row.drugCode}
          rows={table.rows}
          emptyTitle="ไม่พบข้อมูลการจ่ายยา"
          emptyDescription="ลองปรับช่วงวันที่ หรือรอให้ Agent ซิงก์ข้อมูลรอบถัดไป"
          columns={[
            {
              key: "index",
              header: "ลำดับ",
              width: "72px",
              render: (_row, i) => (
                <span className="text-xs text-muted numeric">{(page - 1) * PAGE_SIZE + i + 1}</span>
              ),
            },
            {
              key: "code",
              header: "รหัสยา",
              render: (row) => <span className="numeric text-xs text-muted">{row.drugCode}</span>,
            },
            {
              key: "name",
              header: "ชื่อยา",
              render: (row) => (
                <Link
                  href={`/reports/drug-usage/${encodeURIComponent(row.drugCode)}?from=${from}&to=${to}${
                    requestedFacility ? `&facility=${requestedFacility}` : ""
                  }`}
                  className="font-medium text-ink hover:text-brand-700 hover:underline"
                >
                  {row.drugName}
                </Link>
              ),
            },
            {
              key: "type",
              header: "ประเภท",
              render: (row) => <span className="text-xs text-muted">{drugTypeLabel(row.drugType)}</span>,
            },
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
              render: (row) => <span className="text-xs text-muted">{row.unit ?? "-"}</span>,
            },
          ]}
        />
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={table.total}
          basePath="/reports/drug-usage"
          params={queryParams}
        />
      </Card>
    </>
  );
}
