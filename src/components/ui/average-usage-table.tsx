"use client";

import { Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import { EmptyState, formatNumber, inputClass } from "@/components/ui/primitives";
import { drugTypeLabel } from "@/lib/shared/drug-types";
import type { AverageMonthlyDrugUsageRow } from "@/lib/services/reports";

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
export function AverageUsageTable({ rows }: { rows: AverageMonthlyDrugUsageRow[] }) {
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
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-hairline px-4 py-3 no-print">
        <label className="min-w-[220px] flex-1">
          <span className="mb-1 block text-xs font-medium text-muted">
            ค้นหาชื่อยา / รหัสยา (พิมพ์แล้วกรองทันที)
          </span>
          <span className="relative block">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="เช่น พารา, amlo, P189"
              className={`${inputClass} pl-8`}
              autoComplete="off"
            />
          </span>
        </label>

        <label>
          <span className="mb-1 block text-xs font-medium text-muted">เรียงลำดับ</span>
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as SortKey);
              setPage(1);
            }}
            className={inputClass}
          >
            <option value="average">เฉลี่ยต่อเดือนมากสุด</option>
            <option value="total">ปริมาณใช้รวมมากสุด</option>
            <option value="name">ชื่อยา (ก-ฮ / A-Z)</option>
          </select>
        </label>

        <p className="pb-2.5 text-xs text-muted">
          พบ {formatNumber(filtered.length)} รายการ
          {query ? ` จากทั้งหมด ${formatNumber(rows.length)}` : ""}
        </p>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title={query ? `ไม่พบยาที่ตรงกับ "${query}"` : "ไม่พบข้อมูลการใช้ยาในช่วงเดือนที่เลือก"}
          description={query ? "ลองพิมพ์เพียงบางส่วนของชื่อยา" : undefined}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[13.5px]">
            <thead className="sticky top-0 z-10 bg-raised">
              <tr className="border-b border-line">
                {[
                  ["ลำดับ", "left"],
                  ["รหัสยา", "left"],
                  ["ชื่อยา", "left"],
                  ["หน่วย", "left"],
                  ["ปริมาณใช้รวม", "right"],
                  ["จำนวนเดือน", "right"],
                  ["เฉลี่ยต่อเดือน", "right"],
                ].map(([header, align]) => (
                  <th
                    key={header}
                    scope="col"
                    className={`whitespace-nowrap px-4 py-2.5 text-[12.5px] font-semibold text-muted ${
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
                  className="border-b border-hairline transition-colors duration-150 last:border-0 hover:bg-raised"
                >
                  <td className="px-4 py-2.5 text-xs text-muted numeric">
                    {(currentPage - 1) * PAGE_SIZE + index + 1}
                  </td>
                  <td className="px-4 py-2.5 numeric text-xs text-muted">{row.drugCode}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-ink">{row.drugName}</span>
                    <span className="ml-2 inline-flex whitespace-nowrap rounded-full bg-raised px-2 py-0.5 text-xs text-muted">
                      {drugTypeLabel(row.drugType)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">{row.unit ?? "-"}</td>
                  <td className="px-4 py-2.5 text-right numeric">{formatNumber(row.totalQuantity)}</td>
                  <td className="px-4 py-2.5 text-right numeric text-muted">{formatNumber(row.monthCount)}</td>
                  <td className="px-4 py-2.5 text-right numeric font-semibold text-ink">
                    {formatAverage(row.averagePerMonth)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-2.5 no-print">
          <p className="text-xs text-muted">
            แสดง {formatNumber((currentPage - 1) * PAGE_SIZE + 1)}-
            {formatNumber(Math.min(currentPage * PAGE_SIZE, filtered.length))} จาก{" "}
            {formatNumber(filtered.length)} รายการ
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="rounded-[6px] border border-line px-2.5 py-1 text-xs transition-colors duration-150 hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
            >
              ก่อนหน้า
            </button>
            <span className="text-xs text-muted">
              หน้า {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="rounded-[6px] border border-line px-2.5 py-1 text-xs transition-colors duration-150 hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
            >
              ถัดไป
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
