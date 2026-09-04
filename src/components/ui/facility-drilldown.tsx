"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState, formatNumber } from "@/components/ui/primitives";
import { drugStatus, drugTypeLabel } from "@/lib/shared/drug-types";

export interface FacilitySummary {
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  totalQuantity: number;
  dispensingRows: number;
  distinctDrugs: number;
}

export interface FacilityDrug {
  facilityId: string;
  drugCode: string;
  drugName: string;
  drugType: string | null;
  drugFlag: string | null;
  unit: string | null;
  totalQuantity: number;
  dispensingRows: number;
}

const PAGE_SIZE = 20;

/**
 * Facility totals, and the drugs behind whichever facility is selected.
 *
 * Both the totals and every facility's drug list arrive with the page, so
 * choosing a facility or turning a page is instant and never navigates - the
 * numbers on screen stay the ones the date filter selected, which is what makes
 * this readable as one report rather than a series of page loads.
 */
export function FacilityDrilldown({
  facilities,
  drugs,
  linkParams,
  initialFacilityId,
}: {
  facilities: FacilitySummary[];
  drugs: FacilityDrug[];
  /** query string appended to each drug link, e.g. "from=...&to=..." */
  linkParams: string;
  initialFacilityId?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(
    initialFacilityId ?? facilities[0]?.facilityId ?? null,
  );
  const [page, setPage] = useState(1);

  const byFacility = useMemo(() => {
    const map = new Map<string, FacilityDrug[]>();
    for (const drug of drugs) {
      const list = map.get(drug.facilityId);
      if (list) list.push(drug);
      else map.set(drug.facilityId, [drug]);
    }
    // Codes still in use first, alphabetically; retired codes at the bottom.
    for (const list of map.values()) {
      list.sort((a, b) => {
        const rankA = drugStatus(a.drugFlag).rank;
        const rankB = drugStatus(b.drugFlag).rank;
        if (rankA !== rankB) return rankA - rankB;
        return a.drugName.localeCompare(b.drugName, "th");
      });
    }
    return map;
  }, [drugs]);

  const current = facilities.find((facility) => facility.facilityId === selected) ?? null;
  const rows = selected ? (byFacility.get(selected) ?? []) : [];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const retiredCount = rows.filter((row) => drugStatus(row.drugFlag).rank === 2).length;

  const select = (facilityId: string) => {
    setSelected(facilityId);
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <section className="rounded-[10px] border border-line bg-surface">
        <div className="border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">ปริมาณการจ่ายยาแยกตามสถานบริการ</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            เรียงจากปริมาณมากไปน้อย · เลือกสถานบริการเพื่อดูรายการยาทั้งหมดด้านล่าง
          </p>
        </div>

        {facilities.length === 0 ? (
          <EmptyState title="ยังไม่มีข้อมูลในช่วงเวลานี้" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13.5px]" style={{ minWidth: 640 }}>
              <thead className="bg-raised">
                <tr className="border-b border-line">
                  {["สถานบริการ", "รายการยา", "ครั้งที่จ่าย", "ปริมาณรวม", ""].map(
                    (header, index) => (
                      <th
                        key={header || "action"}
                        scope="col"
                        className={`whitespace-nowrap px-4 py-2.5 text-[12.5px] font-semibold text-muted ${
                          index >= 1 && index <= 3 ? "text-right" : "text-left"
                        }`}
                      >
                        {header}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {facilities.map((facility) => {
                  const active = facility.facilityId === selected;
                  return (
                    <tr
                      key={facility.facilityId}
                      onClick={() => select(facility.facilityId)}
                      className={`cursor-pointer border-b border-hairline transition-colors duration-150 last:border-0 ${
                        active ? "bg-brand-soft" : "hover:bg-raised"
                      }`}
                    >
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            select(facility.facilityId);
                          }}
                          aria-pressed={active}
                          className="text-left font-medium text-ink"
                        >
                          {facility.facilityName}
                          <span className="mt-0.5 block text-xs font-normal text-muted">
                            {facility.facilityCode}
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-right numeric">
                        {formatNumber(facility.distinctDrugs)}
                      </td>
                      <td className="px-4 py-2.5 text-right numeric">
                        {formatNumber(facility.dispensingRows)}
                      </td>
                      <td className="px-4 py-2.5 text-right numeric font-medium">
                        {formatNumber(facility.totalQuantity)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <ChevronRight
                          aria-hidden
                          className={`inline size-4 ${active ? "text-brand" : "text-muted/60"}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {current ? (
        <section className="rounded-[10px] border border-line bg-surface">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-3.5">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">
                รายการยาที่จ่าย · {current.facilityName}
              </h2>
              <p className="mt-0.5 text-[13px] text-muted">
                {formatNumber(rows.length)} รายการในช่วงเวลาที่เลือก
                {retiredCount ? ` · รหัสที่ปิดใช้งานแล้ว ${formatNumber(retiredCount)} รายการ อยู่ท้ายรายการ` : ""}
              </p>
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title="ไม่มีการจ่ายยาในช่วงเวลานี้"
              description="ลองขยายช่วงวันที่ด้านบน"
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13.5px]" style={{ minWidth: 760 }}>
                  <thead className="bg-raised">
                    <tr className="border-b border-line">
                      {[
                        ["ลำดับ", "text-left"],
                        ["หมวดยา", "text-left"],
                        ["รหัสยา", "text-left"],
                        ["ชื่อยา", "text-left"],
                        ["สถานะรหัส", "text-left"],
                        ["ครั้งที่จ่าย", "text-right"],
                        ["จำนวนจ่าย", "text-right"],
                        ["หน่วย", "text-left"],
                      ].map(([header, align]) => (
                        <th
                          key={header}
                          scope="col"
                          className={`whitespace-nowrap px-4 py-2.5 text-[12.5px] font-semibold text-muted ${align}`}
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
                        <td className="px-4 py-2.5">
                          <span className="inline-flex whitespace-nowrap rounded-full bg-raised px-2 py-0.5 text-xs text-muted">
                            {drugTypeLabel(row.drugType)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 numeric text-xs text-muted">{row.drugCode}</td>
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/reports/drug-usage/${encodeURIComponent(row.drugCode)}?${linkParams}`}
                            className="font-medium text-ink transition-colors duration-150 hover:text-brand"
                          >
                            {row.drugName}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${
                              drugStatus(row.drugFlag).className
                            }`}
                          >
                            {drugStatus(row.drugFlag).label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right numeric">
                          {formatNumber(row.dispensingRows)}
                        </td>
                        <td className="px-4 py-2.5 text-right numeric">
                          {formatNumber(row.totalQuantity)}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted">{row.unit ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-2.5 no-print">
                  <p className="text-xs text-muted">
                    แสดง {formatNumber((currentPage - 1) * PAGE_SIZE + 1)}-
                    {formatNumber(Math.min(currentPage * PAGE_SIZE, rows.length))} จาก{" "}
                    {formatNumber(rows.length)} รายการ
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
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
                      onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                      disabled={currentPage === totalPages}
                      className="rounded-[6px] border border-line px-2.5 py-1 text-xs transition-colors duration-150 hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      ถัดไป
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
