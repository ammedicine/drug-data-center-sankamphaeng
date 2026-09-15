import Link from "next/link";
import { Download } from "lucide-react";

import { FilterBar, FilterChip, FilterField } from "@/components/ui/filter-bar";
import { AverageUsageTable } from "@/components/ui/average-usage-table";
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
import { getAvailableDrugTypes, getAverageMonthlyDrugUsage } from "@/lib/services/reports";
import {
  MAX_RESERVE_MONTHS,
  MIN_RESERVE_MONTHS,
  planConsumptionRateReport,
  withReserve,
} from "@/lib/reports/consumption-rate";
import { PRIMARY_DRUG_TYPES, drugTypeLabel } from "@/lib/shared/canonical";

export const metadata = { title: "อัตราการใช้ยาเฉลี่ย" };
export const dynamic = "force-dynamic";

const TITLE = "อัตราการใช้ยาเฉลี่ย";
const SUBTITLE = "คำนวณปริมาณการใช้ยาเฉลี่ยต่อเดือนจากข้อมูลการจ่ายยาที่นำเข้าสู่ระบบ";

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/** `types=01&types=10` (or `01,10`) -> ["01","10"]; empty means "use the default scope". */
function parseTypes(value: unknown): string[] | null {
  const raw = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^\d{1,2}$/.test(item));
  return list.length ? list : null;
}

/** Clean decimals for the summary card: 4,115 or 4,114.67, never a long tail. */
function formatAverage(value: number): string {
  return value.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

export default async function DrugConsumptionRatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const isSuper = user.role === "SUPER_ADMIN";

  const startMonthParam = firstParam(params.startMonth);
  const endMonthParam = firstParam(params.endMonth);
  const requestedFacility = firstParam(params.facility);
  const reserveMonthsParam = firstParam(params.reserveMonths);

  const view = planConsumptionRateReport({
    startMonth: startMonthParam,
    endMonth: endMonthParam,
    reserveMonths: reserveMonthsParam,
  });

  // Category scope is decided server-side, exactly like the usage report:
  // USER/ADMIN never widen past ยา (01, 10); SUPER_ADMIN may add more.
  const typeScope = resolveDrugTypeScope(user, parseTypes(params.types));

  let scope: { facilityIds: string[] | null; single: string | null };
  try {
    scope = resolveFacilityScope(user, requestedFacility);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return (
        <>
          <PageHeader title={TITLE} />
          <ErrorState
            title="ไม่มีสิทธิ์เข้าถึงข้อมูลของสถานบริการนี้"
            detail="บัญชีของคุณเห็นได้เฉพาะข้อมูลสถานบริการของตนเองเท่านั้น"
          />
        </>
      );
    }
    throw error;
  }

  const [availableTypes, facilityOptions] = await Promise.all([
    typeScope.canWiden ? getAvailableDrugTypes(scope.facilityIds) : Promise.resolve([]),
    isSuper ? listFacilityOptions(null) : Promise.resolve([]),
  ]);

  const selectableTypes = [
    ...PRIMARY_DRUG_TYPES,
    ...availableTypes
      .map((t) => t.drugType)
      .filter((type) => !(PRIMARY_DRUG_TYPES as readonly string[]).includes(type)),
  ];

  const result =
    view.mode === "result" && view.from && view.to
      ? await getAverageMonthlyDrugUsage(
          {
            facilityIds: scope.facilityIds,
            from: view.from,
            to: view.to,
            drugTypes: typeScope.types,
          },
          view.monthCount ?? 1,
        )
      : null;

  const reserveRows = result ? withReserve(result.rows, view.reserveMonths) : [];

  // Export carries the exact report filters (client search is view-only and not
  // part of the calculated set), so the file matches what was calculated.
  const exportQuery = new URLSearchParams(
    Object.entries({
      startMonth: view.startMonth,
      endMonth: view.endMonth,
      types: typeScope.types.join(","),
      facility: requestedFacility ?? undefined,
      reserveMonths: String(view.reserveMonths),
    }).filter(([, v]) => v) as [string, string][],
  ).toString();

  return (
    <>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          result ? (
            <Link
              href={`/api/reports/drug-consumption-rate/export?${exportQuery}`}
              className={buttonClass("secondary", "sm")}
            >
              <Download aria-hidden className="size-4" />
              ส่งออก Excel
            </Link>
          ) : undefined
        }
      />

      <FilterBar
        resetHref="/reports/drug-consumption-rate"
        submitLabel="คำนวณ"
        className="mb-5"
        note={
          typeScope.canWiden
            ? "ค่าเริ่มต้นแสดงเฉพาะ ยาแผนปัจจุบันและยาสมุนไพร (วัคซีนติ๊กเพิ่มได้)"
            : "บัญชีของคุณดูได้เฉพาะยา 3 หมวดนี้"
        }
      >
        <FilterField label="เดือนเริ่มต้น">
          <input type="month" name="startMonth" defaultValue={view.startMonth} className={inputClass} />
        </FilterField>
        <FilterField label="เดือนสิ้นสุด">
          <input type="month" name="endMonth" defaultValue={view.endMonth} className={inputClass} />
        </FilterField>
        <FilterField label="สำรองคงคลัง (เดือน)" hint="จำนวนเดือนที่ต้องการสำรองจากอัตราการใช้เฉลี่ย">
          <input
            type="number"
            name="reserveMonths"
            defaultValue={view.reserveMonthsInput}
            min={MIN_RESERVE_MONTHS}
            max={MAX_RESERVE_MONTHS}
            step={0.1}
            className={inputClass}
          />
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

      {view.mode === "error" ? (
        <ErrorState title="ช่วงเดือนไม่ถูกต้อง" detail={view.error ?? undefined} />
      ) : view.mode === "form" || !result ? (
        <Card title="วิธีคำนวณ" className="mt-1">
          <div className="space-y-2 p-4 text-sm text-ink-soft">
            <p>เลือกเดือนเริ่มต้นและเดือนสิ้นสุด แล้วกด “คำนวณ” เพื่อดูอัตราการใช้ยาเฉลี่ยต่อเดือน</p>
            <p className="rounded-[8px] bg-raised px-3 py-2 text-[13px]">
              อัตราการใช้ยาเฉลี่ยต่อเดือน = ปริมาณใช้รวมในช่วงที่เลือก ÷ จำนวนเดือนทั้งหมด (นับแบบรวมทั้งเดือนเริ่มต้นและสิ้นสุด)
            </p>
            <p className="text-xs text-muted">
              เดือนที่ไม่มีการจ่ายยา จะนับเป็นศูนย์ในตัวหาร เช่น ม.ค. 100 + ก.พ. 0 + มี.ค. 50 = 150 ÷ 3 เดือน = 50 หน่วย/เดือน
            </p>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="ช่วงที่คำนวณ" value={view.monthCount ?? 0} unit="เดือน" />
            <StatCard label="จำนวนรายการยา" value={result.summary.distinctDrugs} unit="รายการ" />
            <StatCard label="ปริมาณใช้รวม" value={result.summary.totalQuantity} unit="หน่วย" />
            <StatCard
              label="เฉลี่ยการใช้รวมต่อเดือน"
              value={formatAverage(result.summary.averageTotalPerMonth)}
              unit="หน่วย/เดือน"
              accent
            />
          </div>

          <p className="mt-3 text-xs text-muted">
            สำรองคงคลัง <span className="font-semibold text-ink">{formatAverage(view.reserveMonths)}</span> เดือน ·
            ปริมาณสำรองที่แนะนำ = อัตราการใช้เฉลี่ยต่อเดือน × จำนวนเดือนสำรอง
          </p>

          {view.currentMonthNote ? (
            <p className="mt-2 rounded-[8px] bg-warn-soft px-3 py-2 text-xs text-warn">
              เดือนปัจจุบันยังไม่สิ้นสุด ตัวเลขเดือนนี้เป็นข้อมูลที่มีถึงวันที่นำเข้าล่าสุด
            </p>
          ) : null}

          <Card
            title="อัตราการใช้ยาเฉลี่ยต่อเดือน รายรายการ"
            description={`ช่วง ${view.startMonth} ถึง ${view.endMonth} · ${formatNumber(
              view.monthCount ?? 0,
            )} เดือน · สำรอง ${formatAverage(view.reserveMonths)} เดือน · เรียงตามค่าเฉลี่ยมากไปน้อย · พิมพ์ค้นหาแล้วกรองทันที`}
            className="mt-5"
          >
            <AverageUsageTable rows={reserveRows} />
          </Card>
        </>
      )}
    </>
  );
}
