import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";

import { EmptyState } from "./primitives";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  width?: string;
  /** hide on small screens when the column is secondary detail */
  hideBelow?: "sm" | "md" | "lg";
  render: (row: T, index: number) => ReactNode;
}

const HIDE_CLASS = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

function alignClass(align: Column<unknown>["align"]): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

/**
 * Operational table: dense rows, hairline separators, a sticky header for long
 * lists, and horizontal scrolling contained inside the component so the page
 * body never scrolls sideways.
 *
 * No zebra striping - hairlines plus a hover row read better on screens that
 * are mostly numbers, and striping fights with the status tints.
 */
export function DataTable<T>({
  columns,
  rows,
  emptyTitle = "ไม่พบข้อมูล",
  emptyDescription,
  rowKey,
  caption,
  minWidth = 640,
}: {
  columns: Column<T>[];
  rows: T[];
  emptyTitle?: string;
  emptyDescription?: string;
  rowKey: (row: T, index: number) => string;
  caption?: string;
  minWidth?: number;
}) {
  if (!rows.length) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]" style={{ minWidth }}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="sticky top-0 z-10 bg-raised">
          <tr className="border-b border-line">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={col.width ? { width: col.width } : undefined}
                className={clsx(
                  "whitespace-nowrap px-4 py-2.5 text-[12.5px] font-semibold text-muted",
                  alignClass(col.align),
                  col.hideBelow && HIDE_CLASS[col.hideBelow],
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className="border-b border-hairline transition-colors duration-150 last:border-0 hover:bg-raised"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={clsx(
                    "px-4 py-2.5 align-middle text-ink",
                    alignClass(col.align),
                    col.align === "right" && "numeric",
                    col.hideBelow && HIDE_CLASS[col.hideBelow],
                  )}
                >
                  {col.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Secondary line under a primary cell value (codes, hostnames, timestamps). */
export function CellMeta({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-xs text-muted">{children}</span>;
}

/** Server-rendered pagination that preserves the current query string. */
export function Pagination({
  page,
  pageSize,
  total,
  basePath,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  params: Record<string, string | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    search.set("page", String(target));
    return `${basePath}?${search.toString()}`;
  };

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const linkClass =
    "rounded-[6px] border border-line px-2.5 py-1 text-xs text-ink transition-colors duration-150 hover:bg-raised";

  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-2.5 no-print"
      aria-label="แบ่งหน้า"
    >
      <p className="text-xs text-muted">
        แสดง {from.toLocaleString("th-TH")}-{to.toLocaleString("th-TH")} จาก{" "}
        {total.toLocaleString("th-TH")} รายการ
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={linkClass}>
            ก่อนหน้า
          </Link>
        ) : null}
        <span className="text-xs text-muted">
          หน้า {page} / {totalPages}
        </span>
        {page < totalPages ? (
          <Link href={href(page + 1)} className={linkClass}>
            ถัดไป
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
