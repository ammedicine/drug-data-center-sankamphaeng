"use client";

import clsx from "clsx";
import {
  CalendarRange,
  ChartNoAxesColumnIncreasing,
  CheckCircle2,
  Clock3,
  ClipboardList,
  Database,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";
import React, { type ReactNode, useMemo, useState } from "react";

import { formatDate, formatNumber } from "./primitives";

export interface SyncBatchPresentation {
  id: string;
  batchRef: string;
  facilityCode: string;
  facilityName: string;
  agentName: string;
  mode: string;
  status: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  startedAt: string;
  recordsRead: number;
  recordsAccepted: number;
  recordsRejected: number;
  errorMessage: string | null;
}

export interface SyncHistoryFilters {
  from: string;
  to: string;
  facility: string;
  status: string;
  mode: string;
  search: string;
}

const EMPTY_FILTERS: SyncHistoryFilters = {
  from: "",
  to: "",
  facility: "",
  status: "",
  mode: "",
  search: "",
};

const MODE_LABELS: Record<string, string> = {
  INITIAL: "ซิงก์ครั้งแรก",
  INCREMENTAL: "ซิงก์ต่อเนื่อง",
  MANUAL_RANGE: "เลือกช่วงเอง",
  RETRY: "ส่งซ้ำ",
};

const STATUS_LABELS: Record<string, string> = {
  STARTED: "เริ่มแล้ว",
  UPLOADING: "กำลังอัปโหลด",
  COMPLETED: "สำเร็จ",
  FAILED: "ล้มเหลว",
  ABORTED: "ยุติแล้ว",
};

function startedDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function filterSyncBatches(
  batches: SyncBatchPresentation[],
  filters: SyncHistoryFilters,
): SyncBatchPresentation[] {
  const query = filters.search.trim().toLocaleLowerCase("th-TH");
  return batches.filter((batch) => {
    const date = startedDateKey(batch.startedAt);
    if (filters.from && date < filters.from) return false;
    if (filters.to && date > filters.to) return false;
    if (filters.facility && batch.facilityCode !== filters.facility) return false;
    if (filters.status && batch.status !== filters.status) return false;
    if (filters.mode && batch.mode !== filters.mode) return false;
    if (!query) return true;
    return [batch.batchRef, batch.agentName, batch.facilityCode, batch.facilityName]
      .join(" ")
      .toLocaleLowerCase("th-TH")
      .includes(query);
  });
}

export function summarizeSyncBatches(batches: SyncBatchPresentation[]) {
  return {
    total: batches.length,
    completed: batches.filter((batch) => batch.status === "COMPLETED").length,
    inProgress: batches.filter((batch) => batch.status === "STARTED" || batch.status === "UPLOADING").length,
    failed: batches.filter((batch) => batch.status === "FAILED").length,
  };
}

export interface SyncActivityDay {
  date: string;
  completed: number;
  inProgress: number;
  failed: number;
  other: number;
}

export function groupSyncActivity(batches: SyncBatchPresentation[]): SyncActivityDay[] {
  const days = new Map<string, SyncActivityDay>();
  for (const batch of batches) {
    const date = startedDateKey(batch.startedAt);
    if (!date) continue;
    const day = days.get(date) ?? { date, completed: 0, inProgress: 0, failed: 0, other: 0 };
    if (batch.status === "COMPLETED") day.completed += 1;
    else if (batch.status === "STARTED" || batch.status === "UPLOADING") day.inProgress += 1;
    else if (batch.status === "FAILED") day.failed += 1;
    else day.other += 1;
    days.set(date, day);
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

const INPUT_CLASS =
  "h-9 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-[12.5px] text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100";

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11.5px] font-semibold text-slate-700">{label}</span>
      {children}
    </label>
  );
}

function SyncHistoryFilterPanel({
  batches,
  filters,
  onChange,
  onReset,
}: {
  batches: SyncBatchPresentation[];
  filters: SyncHistoryFilters;
  onChange: (next: SyncHistoryFilters) => void;
  onReset: () => void;
}) {
  const facilities = useMemo(() => {
    const found = new Map<string, string>();
    for (const batch of batches) found.set(batch.facilityCode, `${batch.facilityCode} · ${batch.facilityName}`);
    return [...found.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  }, [batches]);
  const statuses = useMemo(() => [...new Set(batches.map((batch) => batch.status))].sort(), [batches]);
  const modes = useMemo(() => [...new Set(batches.map((batch) => batch.mode))].sort(), [batches]);
  const set = (key: keyof SyncHistoryFilters, value: string) => onChange({ ...filters, [key]: value });

  return (
    <section className="rounded-[16px] border border-slate-200/85 bg-white px-4 py-3.5 shadow-[0_8px_28px_rgba(31,78,112,0.06)] sm:px-5">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">
          <CalendarRange aria-hidden className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-bold text-slate-900">ค้นหาและกรองข้อมูล</h2>
          <p className="text-[10.5px] text-muted">กรองทันทีจากข้อมูลประวัติที่โหลดอยู่ในหน้านี้</p>
        </div>
      </div>

      <div className="grid items-end gap-2.5 sm:grid-cols-2 xl:grid-cols-[0.8fr_0.8fr_1.25fr_1fr_1.15fr]">
        <FilterField label="วันที่เริ่ม">
          <input className={INPUT_CLASS} type="date" value={filters.from} onChange={(event) => set("from", event.target.value)} />
        </FilterField>
        <FilterField label="วันที่สิ้นสุด">
          <input className={INPUT_CLASS} type="date" value={filters.to} onChange={(event) => set("to", event.target.value)} />
        </FilterField>
        <FilterField label="สถานบริการ">
          <select className={INPUT_CLASS} value={filters.facility} onChange={(event) => set("facility", event.target.value)}>
            <option value="">ทุกสถานบริการ</option>
            {facilities.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </FilterField>
        <FilterField label="สถานะ">
          <select className={INPUT_CLASS} value={filters.status} onChange={(event) => set("status", event.target.value)}>
            <option value="">ทุกสถานะ</option>
            {statuses.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] ?? status}</option>)}
          </select>
        </FilterField>
        <FilterField label="ประเภทการซิงก์">
          <select className={INPUT_CLASS} value={filters.mode} onChange={(event) => set("mode", event.target.value)}>
            <option value="">ทุกประเภท</option>
            {modes.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode] ?? mode}</option>)}
          </select>
        </FilterField>
      </div>

      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">ค้นหา Batch / Agent / สถานบริการ</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            className={clsx(INPUT_CLASS, "pl-9")}
            type="search"
            value={filters.search}
            onChange={(event) => set("search", event.target.value)}
            placeholder="ค้นหา Batch / Agent / สถานบริการ"
          />
        </label>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[8px] border border-slate-200 bg-white px-3.5 text-[12.5px] font-semibold text-slate-600 transition hover:bg-slate-50"
        >
          <RotateCcw aria-hidden className="size-4" />
          ล้างค่า
        </button>
      </div>
    </section>
  );
}

const KPI_META = [
  { label: "รอบการซิงก์", icon: Database, iconClass: "bg-blue-50 text-blue-600", key: "total" },
  { label: "สำเร็จ", icon: CheckCircle2, iconClass: "bg-emerald-50 text-emerald-600", key: "completed" },
  { label: "กำลังดำเนินการ", icon: Clock3, iconClass: "bg-amber-50 text-amber-600", key: "inProgress" },
  { label: "ล้มเหลว", icon: XCircle, iconClass: "bg-red-50 text-red-600", key: "failed" },
] as const;

function HistoryKpiGrid({ batches, filtered }: { batches: SyncBatchPresentation[]; filtered: SyncBatchPresentation[] }) {
  const summary = summarizeSyncBatches(filtered);
  return (
    <section aria-label="สรุปจากประวัติ 50 รอบล่าสุด">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 px-0.5">
        <h2 className="text-[12.5px] font-semibold text-slate-700">สรุปจากประวัติ 50 รอบล่าสุด</h2>
        <p className="text-[10.5px] text-muted">ตามตัวกรองปัจจุบัน · แสดง {filtered.length} จาก {batches.length} รอบที่โหลด</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {KPI_META.map((item) => {
          const Icon = item.icon;
          return (
            <article key={item.key} className="rounded-[14px] border border-slate-200/85 bg-white px-4 py-3 shadow-[0_7px_22px_rgba(31,78,112,0.055)]">
              <div className="flex items-center gap-3">
                <span className={clsx("inline-flex size-10 shrink-0 items-center justify-center rounded-full", item.iconClass)}>
                  <Icon aria-hidden className="size-5" />
                </span>
                <div>
                  <p className="text-[12px] font-semibold text-slate-600">{item.label}</p>
                  <p className="numeric mt-1 text-[25px] font-bold leading-none text-slate-950">{formatNumber(summary[item.key])}</p>
                  <p className="mt-1.5 text-[10.5px] text-muted">จากข้อมูลสูงสุด 50 รอบล่าสุด</p>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ActivityChart({ batches }: { batches: SyncBatchPresentation[] }) {
  const days = groupSyncActivity(batches);
  const maximum = Math.max(1, ...days.map((day) => day.completed + day.inProgress + day.failed + day.other));
  return (
    <section className="h-full overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-violet-50 text-violet-600">
            <ChartNoAxesColumnIncreasing aria-hidden className="size-[18px]" />
          </span>
          <div>
            <h2 className="text-[14px] font-bold text-slate-900">กิจกรรมจาก 50 รอบการซิงก์ล่าสุด</h2>
            <p className="text-[10.5px] text-muted">จัดกลุ่มตามวันที่เริ่มของรอบที่อยู่ในตัวกรอง</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10.5px] text-muted">
          <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-emerald-500" />สำเร็จ</span>
          <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-amber-400" />กำลังดำเนินการ</span>
          <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-red-500" />ล้มเหลว</span>
        </div>
      </div>
      {days.length ? (
        <div className="overflow-x-auto px-4 pb-3 pt-4">
          <div className="flex h-[154px] min-w-[520px] items-end gap-2 border-b border-slate-200">
            {days.map((day) => {
              const total = day.completed + day.inProgress + day.failed + day.other;
              const height = Math.max(8, Math.round((total / maximum) * 116));
              return (
                <div key={day.date} className="group flex min-w-[26px] flex-1 flex-col items-center justify-end self-stretch">
                  <div className="mb-1 text-[9px] font-semibold text-slate-500 opacity-0 transition group-hover:opacity-100">{total}</div>
                  <div className="flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-t-[4px]" style={{ height }} title={`${day.date}: ${total} รอบ`}>
                    {day.completed ? <span className="bg-emerald-500" style={{ flex: day.completed }} /> : null}
                    {day.inProgress ? <span className="bg-amber-400" style={{ flex: day.inProgress }} /> : null}
                    {day.failed ? <span className="bg-red-500" style={{ flex: day.failed }} /> : null}
                    {day.other ? <span className="bg-slate-400" style={{ flex: day.other }} /> : null}
                  </div>
                  <span className="mt-1.5 whitespace-nowrap text-[9px] text-slate-400">
                    {new Date(`${day.date}T00:00:00+07:00`).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex h-[170px] items-center justify-center text-xs text-muted">ไม่มีกิจกรรมตามตัวกรองปัจจุบัน</div>
      )}
    </section>
  );
}

function BatchStatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx(
      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
      status === "COMPLETED" && "bg-emerald-50 text-emerald-700",
      (status === "STARTED" || status === "UPLOADING") && "bg-amber-50 text-amber-700",
      status === "FAILED" && "bg-red-50 text-red-700",
      status === "ABORTED" && "bg-slate-100 text-slate-600",
    )}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function HistoryTable({ batches, showFacility, showTechnicalError }: {
  batches: SyncBatchPresentation[];
  showFacility: boolean;
  showTechnicalError: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">
            <ClipboardList aria-hidden className="size-[18px]" />
          </span>
          <div>
            <h2 className="text-[15px] font-bold text-slate-900">ประวัติการซิงก์ข้อมูล</h2>
            <p className="text-[10.5px] text-muted">รายการจากประวัติ 50 รอบล่าสุดตามตัวกรองปัจจุบัน</p>
          </div>
        </div>
        <p className="rounded-[8px] border border-slate-200 bg-white px-3 py-1.5 text-[11px] text-slate-500">
          แสดง <strong className="numeric text-slate-800">{formatNumber(batches.length)}</strong> รายการ
        </p>
      </div>
      {batches.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-[11.5px]">
            <thead className="bg-slate-50/90 text-left text-[11px] font-semibold text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="w-10 px-3 py-2.5 text-center">#</th>
                <th className="px-3 py-2.5">วันที่เริ่ม</th>
                <th className="px-3 py-2.5">เวลา</th>
                {showFacility ? <th className="px-3 py-2.5">สถานบริการ</th> : null}
                <th className="px-3 py-2.5">Agent</th>
                <th className="px-3 py-2.5">ประเภทข้อมูล</th>
                <th className="px-3 py-2.5">ช่วงข้อมูลที่อ่าน</th>
                <th className="px-3 py-2.5 text-right">จำนวนรายการ</th>
                <th className="px-3 py-2.5 text-right">บันทึกสำเร็จ</th>
                <th className="px-3 py-2.5 text-right">ถูกปฏิเสธ</th>
                <th className="px-3 py-2.5">สถานะ</th>
                <th className="px-4 py-2.5">Batch ID</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch, index) => (
                <tr key={batch.id} className="border-b border-slate-100 transition-colors last:border-0 hover:bg-blue-50/30">
                  <td className="numeric px-3 py-2.5 text-center text-slate-500">{index + 1}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{formatDate(batch.startedAt)}</td>
                  <td className="numeric whitespace-nowrap px-3 py-2.5 text-slate-500">
                    {new Date(batch.startedAt).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </td>
                  {showFacility ? (
                    <td className="px-3 py-2.5 text-slate-600">
                      <p className="font-medium text-slate-700">{batch.facilityName}</p>
                      <p className="numeric mt-0.5 text-[10px] text-muted">{batch.facilityCode}</p>
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5 text-slate-600">{batch.agentName}</td>
                  <td className="px-3 py-2.5"><span className="whitespace-nowrap rounded-full bg-blue-50 px-2 py-0.5 text-[10.5px] font-semibold text-blue-700">{MODE_LABELS[batch.mode] ?? batch.mode}</span></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">
                    {batch.rangeFrom && batch.rangeTo ? `${formatDate(batch.rangeFrom)} – ${formatDate(batch.rangeTo)}` : "-"}
                  </td>
                  <td className="numeric px-3 py-2.5 text-right text-slate-700">{formatNumber(batch.recordsRead)}</td>
                  <td className="numeric px-3 py-2.5 text-right text-slate-700">{formatNumber(batch.recordsAccepted)}</td>
                  <td className={clsx("numeric px-3 py-2.5 text-right", batch.recordsRejected ? "text-red-600" : "text-slate-500")}>{formatNumber(batch.recordsRejected)}</td>
                  <td className="px-3 py-2.5">
                    <BatchStatusBadge status={batch.status} />
                    {showTechnicalError && batch.errorMessage ? <p className="mt-1 max-w-48 truncate text-[10px] text-red-600" title={batch.errorMessage}>{batch.errorMessage}</p> : null}
                  </td>
                  <td className="numeric whitespace-nowrap px-4 py-2.5 font-medium text-slate-600">{batch.batchRef}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-5 py-10 text-center text-xs text-muted">ไม่พบประวัติตามตัวกรองปัจจุบัน</div>
      )}
    </section>
  );
}

export function SyncHistoryWorkspace({
  batches,
  showFacility,
  showTechnicalError,
  agentSummary,
  runningSync,
}: {
  batches: SyncBatchPresentation[];
  showFacility: boolean;
  showTechnicalError: boolean;
  agentSummary: ReactNode;
  runningSync: ReactNode;
}) {
  const [filters, setFilters] = useState<SyncHistoryFilters>(EMPTY_FILTERS);
  const filtered = useMemo(() => filterSyncBatches(batches, filters), [batches, filters]);

  return (
    <div className="space-y-3">
      <SyncHistoryFilterPanel batches={batches} filters={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      <HistoryKpiGrid batches={batches} filtered={filtered} />
      <div className="grid items-stretch gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
        {agentSummary}
        <ActivityChart batches={filtered} />
      </div>
      {runningSync}
      <HistoryTable batches={filtered} showFacility={showFacility} showTechnicalError={showTechnicalError} />
    </div>
  );
}
