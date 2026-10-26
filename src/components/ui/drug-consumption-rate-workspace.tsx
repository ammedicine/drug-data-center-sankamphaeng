import clsx from "clsx";
import Link from "next/link";
import {
  CalendarDays,
  Calculator,
  FileSpreadsheet,
  PackageOpen,
  RotateCcw,
  Search,
} from "lucide-react";
import React, { type ReactNode } from "react";

export function ConsumptionRatePageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.025em] text-slate-950 sm:text-[30px]">
          {title}
        </h1>
        <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
      </div>
      {actions ? <div className="shrink-0 no-print">{actions}</div> : null}
    </header>
  );
}

export function ConsumptionRateFilterPanel({
  fields,
  categories,
  resetHref,
  note,
}: {
  fields: ReactNode;
  categories: ReactNode;
  resetHref: string;
  note: ReactNode;
}) {
  return (
    <form
      method="get"
      className="rounded-[16px] border border-slate-200/85 bg-white px-4 py-3.5 shadow-[0_8px_28px_rgba(31,78,112,0.06)] no-print sm:px-5"
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">
          <CalendarDays aria-hidden className="size-[18px]" />
        </span>
        <h2 className="text-[15px] font-bold text-slate-900">เลือกเงื่อนไขและช่วงข้อมูล</h2>
      </div>

      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-[0.75fr_0.75fr_1.35fr_1.45fr]">
        {fields}
      </div>

      <fieldset className="mt-3 border-0 p-0">
        <legend className="mb-1.5 text-xs font-semibold text-slate-700">หมวดยา</legend>
        <div className="flex flex-wrap gap-1.5">{categories}</div>
      </fieldset>

      <div className="mt-3 flex flex-col gap-2.5 border-t border-slate-100 pt-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] bg-emerald-600 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            <Search aria-hidden className="size-4" />
            คำนวณ
          </button>
          <Link
            href={resetHref}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <RotateCcw aria-hidden className="size-4" />
            ค่าเริ่มต้น
          </Link>
        </div>
        <p className="text-xs leading-relaxed text-muted sm:ml-auto sm:text-right">{note}</p>
      </div>
    </form>
  );
}

export function ConsumptionRateField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block min-h-4 text-xs font-semibold text-slate-700 xl:whitespace-nowrap">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[10.5px] leading-snug text-muted">{hint}</span> : null}
    </label>
  );
}

export function ConsumptionRateCategoryChip({
  name,
  value,
  label,
  suffix,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: string;
  suffix?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label
      className={clsx(
        "inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] text-slate-600 transition-colors",
        "hover:bg-slate-50 has-[:checked]:border-emerald-200 has-[:checked]:bg-emerald-50 has-[:checked]:font-medium has-[:checked]:text-emerald-700",
      )}
    >
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="size-3.5 accent-emerald-600"
      />
      <span>{label}</span>
      {suffix ? <span className="text-[10.5px] font-normal text-slate-400">{suffix}</span> : null}
    </label>
  );
}

const KPI_STYLES = [
  { icon: CalendarDays, iconClass: "bg-blue-50 text-blue-600" },
  { icon: FileSpreadsheet, iconClass: "bg-emerald-50 text-emerald-600" },
  { icon: PackageOpen, iconClass: "bg-violet-50 text-violet-600" },
  { icon: Calculator, iconClass: "bg-amber-50 text-amber-600" },
] as const;

export function ConsumptionRateKpiGrid({
  monthCount,
  distinctDrugs,
  totalQuantity,
  averageTotalPerMonth,
}: {
  monthCount: number;
  distinctDrugs: number;
  totalQuantity: number;
  averageTotalPerMonth: string;
}) {
  const items = [
    {
      label: "ช่วงที่คำนวณ",
      value: monthCount.toLocaleString("th-TH"),
      unit: "เดือน",
      hint: "จำนวนเดือนที่ใช้ในการคำนวณ",
    },
    {
      label: "จำนวนรายการยา",
      value: distinctDrugs.toLocaleString("th-TH"),
      unit: "รายการ",
      hint: "จำนวนรายการยาที่พบในช่วงข้อมูล",
    },
    {
      label: "ปริมาณใช้รวม",
      value: totalQuantity.toLocaleString("th-TH"),
      unit: "หน่วย",
      hint: "ปริมาณการใช้ยาทั้งหมด",
    },
    {
      label: "เฉลี่ยการใช้ต่อเดือนทั้งหมด",
      value: averageTotalPerMonth,
      unit: "หน่วย/เดือน",
      hint: "ปริมาณการใช้เฉลี่ยต่อเดือน",
    },
  ];

  return (
    <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="สรุปอัตราการใช้ยา">
      {items.map((item, index) => {
        const style = KPI_STYLES[index];
        const Icon = style.icon;
        return (
          <article
            key={item.label}
            data-consumption-kpi={item.label}
            className="rounded-[14px] border border-slate-200/85 bg-white px-4 py-3 shadow-[0_7px_22px_rgba(31,78,112,0.055)]"
          >
            <div className="flex items-start gap-3">
              <span className={clsx("inline-flex size-10 shrink-0 items-center justify-center rounded-full", style.iconClass)}>
                <Icon aria-hidden className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-slate-600">{item.label}</p>
                <p className="mt-1 whitespace-nowrap text-[25px] font-bold leading-none tracking-[-0.02em] text-slate-950 numeric">
                  {item.value}
                  <span className="ml-1.5 text-[12px] font-medium tracking-normal text-muted">{item.unit}</span>
                </p>
                <p className="mt-2 text-[11px] leading-snug text-muted">{item.hint}</p>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}

