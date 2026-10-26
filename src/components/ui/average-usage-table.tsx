"use client";

import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import React, { useDeferredValue, useMemo, useState } from "react";

import { EmptyState, formatNumber, inputClass } from "@/components/ui/primitives";
import { drugTypeLabel } from "@/lib/shared/drug-types";
import type { ReserveUsageRow } from "@/lib/reports/consumption-rate";

type SortKey = "average" | "total" | "name";

const PAGE_SIZE = 25;

/** Clean decimals: 500 stays 500, 5.25 stays 5.25, trailing .00 is dropped. */
function formatAverage(value: number): string {
  return value.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

/** Case-folded, whitespace-free, Thai combining marks stripped (as the usage table). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFC")
    .replace(/[ัิ-ฺ็-๎]/g, "")
    .replace(/\s+/g, "");
}

/**
 * Client-side table over the already-aggregated rows: search and sort filter
 * instantly with no request round trip. A รพ.สต. has a few hundred distinct
 * drugs, so the whole result set ships once with the page.
 */
export function AverageUsageTable({ rows, context }: { rows: ReserveUsageRow[]; context: string }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("average");
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const needle = normalize(deferredQuery.trim());
    const matched = needle
      ? rows.filter(
          (row) => normalize(row.drugName).includes(needle) || normalize(row.drugCode).includes(needle),
        )
      : rows.slice();

    matched.sort((a, b) => {
      if (sort === "name") return a.drugName.localeCompare(b.drugName, "th");
      if (sort === "total") return b.totalQuantity - a.totalQuantity || a.drugName.localeCompare(b.drugName, "th");
      return b.averagePerMonth - a.averagePerMonth || a.drugName.localeCompare(b.drugName, "th");
    });
    return matched;
  }, [rows, deferredQuery, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section className="mt-3 min-w-0 overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.06)]">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 lg:flex-row lg:items-end lg:justify-between sm:px-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-slate-900">อัตราการใช้ยาเฉลี่ยต่อเดือน รายรายการ</h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{context}</p>
        </div>

        <div className="flex flex-col gap-2 no-print sm:flex-row sm:items-end">
          <label className="block min-w-[220px]">
            <span className="sr-only">ค้นหาชื่อยา หรือรหัสยา</span>
          <span className="relative block">
            <Search
              aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
                placeholder="ค้นหาชื่อยา หรือรหัสยา..."
                className={`${inputClass} border-slate-200 bg-white pl-9 shadow-sm`}
              autoComplete="off"
            />
          </span>
        </label>

          <label className="block min-w-[190px]">
            <span className="mb-1 block text-[11px] font-semibold text-slate-600">เรียงลำดับ</span>
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as SortKey);
              setPage(1);
            }}
              className={`${inputClass} border-slate-200 bg-white shadow-sm`}
          >
              <option value="average">เฉลี่ยต่อเดือน (มากสุดก่อน)</option>
            <option value="total">ปริมาณใช้รวมมากสุด</option>
            <option value="name">ชื่อยา (ก-ฮ / A-Z)</option>
          </select>
        </label>

          <p className="whitespace-nowrap pb-2.5 text-xs text-muted">
          พบ {formatNumber(filtered.length)} รายการ
          {query ? ` จากทั้งหมด ${formatNumber(rows.length)}` : ""}
        </p>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title={query ? `ไม่พบยาที่ตรงกับ "${query}"` : "ไม่พบข้อมูลการใช้ยาในช่วงเดือนที่เลือก"}
          description={query ? "ลองพิมพ์เพียงบางส่วนของชื่อยา" : undefined}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] border-collapse text-[12.5px]">
            <thead className="sticky top-0 z-10 bg-slate-50/90">
              <tr className="border-b border-slate-200">
                {[
                  ["ลำดับ", "left"],
                  ["รหัสยา", "left"],
                  ["ชื่อยา", "left"],
                  ["หมวดยา", "left"],
                  ["หน่วย", "left"],
                  ["ปริมาณใช้รวม", "right"],
                  ["จำนวนเดือน", "right"],
                  ["เฉลี่ยต่อเดือน", "right"],
                  ["สำรอง (เดือน)", "right"],
                  ["ปริมาณสำรองที่แนะนำ", "right"],
                ].map(([header, align]) => (
                  <th
                    key={header}
                    scope="col"
                    className={`whitespace-nowrap px-3 py-2 text-[11.5px] font-semibold text-slate-600 ${
                      align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <tr
                  key={`${row.drugType ?? "x"}-${row.drugCode}`}
                  className="border-b border-slate-100 transition-colors duration-150 last:border-0 hover:bg-blue-50/35"
                >
                  <td className="px-3 py-2 text-xs text-muted numeric">
                    {(currentPage - 1) * PAGE_SIZE + index + 1}
                  </td>
                  <td className="px-3 py-2 numeric text-xs text-slate-600">{row.drugCode}</td>
                  <td className="px-3 py-2 font-semibold text-slate-800">{row.drugName}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex whitespace-nowrap rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
                      {drugTypeLabel(row.drugType)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{row.unit ?? "-"}</td>
                  <td className="px-3 py-2 text-right numeric">{formatNumber(row.totalQuantity)}</td>
                  <td className="px-3 py-2 text-right numeric text-muted">{formatNumber(row.monthCount)}</td>
                  <td className="px-3 py-2 text-right numeric">{formatAverage(row.averagePerMonth)}</td>
                  <td className="px-3 py-2 text-right numeric text-muted">{formatAverage(row.reserveMonths)}</td>
                  <td className="px-3 py-2 text-right numeric font-bold text-slate-950">
                    {formatAverage(row.recommendedReserveQuantity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/45 px-4 py-2.5 no-print sm:px-5">
          <p className="text-xs text-muted">
            แสดง {formatNumber((currentPage - 1) * PAGE_SIZE + 1)}-
            {formatNumber(Math.min(currentPage * PAGE_SIZE, filtered.length))} จาก{" "}
            {formatNumber(filtered.length)} รายการ
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              aria-label="หน้าก่อนหน้า"
              className="inline-flex size-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
            <span className="min-w-[88px] text-center text-xs font-medium text-muted">
              หน้า {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              aria-label="หน้าถัดไป"
              className="inline-flex size-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white"
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
