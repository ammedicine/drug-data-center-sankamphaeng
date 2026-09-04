import Link from "next/link";
import { Download } from "lucide-react";

import { TrendChart } from "@/components/ui/charts";
import { CellMeta, DataTable } from "@/components/ui/data-table";
import { DrugUsageTable } from "@/components/ui/drug-usage-table";
import { FilterBar, FilterChip, FilterField } from "@/components/ui/filter-bar";
import {
  Card,
  ErrorState,
  PageHeader,
  StatCard,
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
  // ยา (01, 05, 10); SUPER_ADMIN starts on the same three and may add more.
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

  // Checkbox list: the three medicine categories always, plus whatever else the
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

  return (
    <>
      <PageHeader
        title="รายงานปริมาณการจ่ายยา"
        subtitle={`${fiscal.label} · ข้อมูลการจ่ายยาให้ผู้รับบริการจาก JHCIS ของสถานบริการ`}
        actions={
          <Link
            href={`/api/reports/drug-usage/export?${new URLSearchParams(
              Object.entries(queryParams).filter(([, v]) => v) as [string, string][],
            ).toString()}`}
            className={buttonClass("secondary", "sm")}
          >
            <Download aria-hidden className="size-4" />
            ส่งออก CSV
          </Link>
        }
      />

      <FilterBar
        resetHref="/reports/drug-usage"
        className="mb-5"
        note={
          typeScope.canWiden
            ? "ค่าเริ่มต้นแสดงเฉพาะ ยาแผนปัจจุบันและยาสมุนไพร (วัคซีนติ๊กเพิ่มได้)"
            : "บัญชีของคุณดูได้เฉพาะยา 3 หมวดนี้"
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
        {isSuper ? (
          <FilterField label="สถานบริการ" className="min-w-[220px] flex-1">
            <select name="facility" defaultValue={requestedFacility ?? ""} className={inputClass}>
              <option value="">ทุกสถานบริการ</option>
              {facilityOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.code} · {f.name}
                </option>
              ))}
            </select>
          </FilterField>
        ) : null}

        <fieldset className="w-full">
          <legend className="mb-1.5 text-xs font-medium text-muted">หมวดยา</legend>
          <div className="flex flex-wrap gap-2">
            {selectableTypes.map((type) => (
              <FilterChip
                key={type}
                name="types"
                value={type}
                label={drugTypeLabel(type)}
                suffix={
                  (PRIMARY_DRUG_TYPES as readonly string[]).includes(type) ? undefined : "ไม่ใช่ยา"
                }
                defaultChecked={typeScope.types.includes(type)}
              />
            ))}
          </div>
        </fieldset>
      </FilterBar>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="รายการจ่ายยา" value={summary.dispensingRows} unit="รายการ" />
        <StatCard label="จำนวนรายการยา" value={summary.distinctDrugs} unit="รายการ" />
        <StatCard label="ปริมาณรวม" value={summary.totalQuantity} unit="หน่วย" />
        <StatCard label="หมวดยาที่แสดง" value={byType.length} unit="หมวด" />
      </div>

      <Card
        title="สรุปตามหมวดยา"
        description="แยกตาม cdrug.drugtype เพื่อไม่ให้ปริมาณของแต่ละหมวดปนกัน"
        className="mt-5"
      >
        <DataTable
          rowKey={(row) => row.drugType ?? "unknown"}
          rows={byType}
          emptyTitle="ไม่มีข้อมูลในช่วงเวลาที่เลือก"
          columns={[
            {
              key: "type",
              header: "หมวดยา",
              render: (row) => (
                <>
                  <span className="font-medium text-ink">{drugTypeLabel(row.drugType)}</span>
                  <CellMeta>รหัส {row.drugType ?? "-"}</CellMeta>
                </>
              ),
            },
            {
              key: "drugs",
              header: "จำนวนรายการยา",
              align: "right",
              render: (row) => formatNumber(row.distinctDrugs),
            },
            {
              key: "rows",
              header: "ครั้งที่จ่าย",
              align: "right",
              render: (row) => formatNumber(row.dispensingRows),
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

      <Card title="แนวโน้มการจ่ายยา" className="mt-5">
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
        description={`ช่วงข้อมูล ${from} ถึง ${to} · แยกตามหมวดยา เรียงตามชื่อยา · พิมพ์ค้นหาแล้วกรองทันที`}
        className="mt-5"
      >
        <DrugUsageTable
          rows={table.rows}
          initialQuery={search ?? ""}
          linkParams={new URLSearchParams(
            Object.entries({
              from,
              to,
              ...(requestedFacility ? { facility: requestedFacility } : {}),
            }),
          ).toString()}
        />
      </Card>
    </>
  );
}
