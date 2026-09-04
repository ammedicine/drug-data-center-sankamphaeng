"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";

import { formatNumber, inputClass } from "@/components/ui/primitives";
import { drugTypeLabel } from "@/lib/shared/drug-types";

export interface DrugUsageTableRow {
  drugCode: string;
  drugName: string;
  drugType: string | null;
  unit: string | null;
  totalQuantity: number;
  dispensingRows: number;
  drugFlag: string | null;
  firstUsageDate: string | null;
  lastUsageDate: string | null;
}

type SortKey = "name" | "quantity" | "rows" | "code";
/** JHCIS cdrug.drugflag: "1" still orderable, "2" switched off */
type StatusKey = "all" | "active" | "inactive";

const PAGE_SIZE = 25;

/**
 * Normalises for matching: case-folded, whitespace-free, and with the Thai
 * combining marks (สระ/วรรณยุกต์) stripped so "พารา" still matches "พาราเซตามอล"
 * even when the typist omits or misplaces a mark.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFC")
    .replace(/[ัิ-ฺ็-๎]/g, "")
    .replace(/\s+/g, "");
}

/** Subsequence match: every character of the query appears in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/** Higher is better; 0 means "no match". */
function score(row: DrugUsageTableRow, query: string): number {
  if (!query) return 1;
  const name = normalize(row.drugName);
  const code = normalize(row.drugCode);

  if (name.startsWith(query)) return 100;
  if (code.startsWith(query)) return 90;
  if (name.includes(query)) return 70;
  if (code.includes(query)) return 60;
  // typo tolerance, e.g. "amlodpine" -> AMLODIPINE
  if (isSubsequence(query, name)) return 30;
  return 0;
}

/**
 * Client-side table: search filters as you type with no request round trip.
 * The whole (already aggregated) result set is sent once with the page, which
 * is a few hundred rows for a รพ.สต. - far cheaper than a request per keystroke
 * and it removes the debounce delay entirely.
 */
export function DrugUsageTable({
  rows,
  linkParams,
  initialQuery = "",
}: {
  rows: DrugUsageTableRow[];
  /** query string appended to each drug link, e.g. "from=...&to=..." */
  linkParams: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState<SortKey>("name");
  const [status, setStatus] = useState<StatusKey>("all");
  const [page, setPage] = useState(1);

  // Keeps typing responsive on large lists: the input updates immediately and
  // the filtered list catches up on the next render pass.
  const deferredQuery = useDeferredValue(query);

  const counts = useMemo(
    () => ({
      all: rows.length,
      active: rows.filter((row) => row.drugFlag !== "2").length,
      inactive: rows.filter((row) => row.drugFlag === "2").length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = normalize(deferredQuery.trim());
    const scored = rows
      .filter((row) =>
        status === "all"
          ? true
          : status === "inactive"
            ? row.drugFlag === "2"
            : row.drugFlag !== "2",
      )
      .map((row) => ({ row, score: score(row, needle) }))
      .filter((item) => item.score > 0);

    scored.sort((a, b) => {
      // While searching, the best match wins; otherwise keep category grouping.
      if (needle && b.score !== a.score) return b.score - a.score;
      const typeA = a.row.drugType ?? "zz";
      const typeB = b.row.drugType ?? "zz";
      if (typeA !== typeB) return typeA.localeCompare(typeB);
      if (sort === "quantity") return b.row.totalQuantity - a.row.totalQuantity;
      if (sort === "rows") return b.row.dispensingRows - a.row.dispensingRows;
      if (sort === "code") return a.row.drugCode.localeCompare(b.row.drugCode, "th");
      return a.row.drugName.localeCompare(b.row.drugName, "th");
    });

    return scored.map((item) => item.row);
  }, [rows, deferredQuery, sort, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div>
      <div className="flex flex-wrap gap-2 border-b border-line px-5 pt-4 no-print">
        {(
            [
              ["all", "ทั้งหมด"],
              ["active", "รหัสที่เปิดใช้งาน"],
              ["inactive", "รหัสที่ปิดใช้งานแล้ว"],
            ] as Array<[StatusKey, string]>
          ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setStatus(key);
              setPage(1);
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              status === key
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-line text-muted hover:bg-canvas"
            }`}
          >
            {label} ({formatNumber(counts[key])})
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-4 no-print">
        <label className="min-w-[240px] flex-1">
          <span className="mb-1.5 block text-xs font-medium text-muted">
            ค้นหาชื่อยา / รหัสยา (พิมพ์แล้วกรองทันที)
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="เช่น พารา, amlo, P189"
            className={inputClass}
            autoComplete="off"
          />
        </label>

        <label>
          <span className="mb-1.5 block text-xs font-medium text-muted">เรียงลำดับ</span>
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as SortKey);
              setPage(1);
            }}
            className={inputClass}
          >
            <option value="name">ชื่อยา (ก-ฮ / A-Z)</option>
            <option value="quantity">ปริมาณจ่ายมากสุด</option>
            <option value="rows">จ่ายบ่อยสุด</option>
            <option value="code">รหัสยา</option>
          </select>
        </label>

        <p className="pb-2 text-xs text-muted">
          พบ {formatNumber(filtered.length)} รายการ
          {query ? ` จากทั้งหมด ${formatNumber(rows.length)}` : ""}
        </p>
      </div>

      {visible.length === 0 ? (
        <p className="px-5 py-16 text-center text-sm text-muted">
          ไม่พบยาที่ตรงกับ &ldquo;{query}&rdquo;
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas/60">
                {[
                  "ลำดับ",
                  "หมวดยา",
                  "รหัสยา",
                  "ชื่อยา",
                  "สถานะรหัส",
                  "ช่วงที่มีการจ่าย",
                  "ครั้งที่จ่าย",
                  "จำนวนจ่าย",
                  "หน่วย",
                ].map((header, index) => (
                  <th
                    key={header}
                    scope="col"
                    className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted ${
                      index === 6 || index === 7 ? "text-right" : "text-left"
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
                  className="border-b border-line/70 last:border-0 hover:bg-canvas/60"
                >
                  <td className="px-4 py-3 text-xs text-muted numeric">
                    {(currentPage - 1) * PAGE_SIZE + index + 1}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">
                      {drugTypeLabel(row.drugType)}
                    </span>
                  </td>
                  <td className="px-4 py-3 numeric text-xs text-muted">{row.drugCode}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/reports/drug-usage/${encodeURIComponent(row.drugCode)}?${linkParams}`}
                      className="font-medium text-ink hover:text-brand-700 hover:underline"
                    >
                      {row.drugName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${
                        row.drugFlag === "2" ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"
                      }`}
                    >
                      {row.drugFlag === "2" ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted numeric">
                    {row.firstUsageDate ?? "-"}
                    {row.lastUsageDate && row.lastUsageDate !== row.firstUsageDate
                      ? ` – ${row.lastUsageDate}`
                      : ""}
                  </td>
                  <td className="px-4 py-3 text-right numeric">{formatNumber(row.dispensingRows)}</td>
                  <td className="px-4 py-3 text-right numeric">{formatNumber(row.totalQuantity)}</td>
                  <td className="px-4 py-3 text-xs text-muted">{row.unit ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 no-print">
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
              className="rounded-lg border border-line px-3 py-1.5 text-xs disabled:opacity-40"
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
              className="rounded-lg border border-line px-3 py-1.5 text-xs disabled:opacity-40"
            >
              ถัดไป
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
