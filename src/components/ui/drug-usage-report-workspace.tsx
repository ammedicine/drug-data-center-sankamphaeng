"use client";

import { BarChart3, ChevronDown, List, Search } from "lucide-react";
import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { inputClass } from "@/components/ui/primitives";
import { drugTypeLabel } from "@/lib/shared/drug-types";

type SearchState = {
  query: string;
  setQuery: (value: string) => void;
};

const DrugUsageSearchContext = createContext<SearchState | null>(null);

export function DrugUsageSearchProvider({
  initialQuery,
  children,
}: {
  initialQuery: string;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery);
  const value = useMemo(() => ({ query, setQuery }), [query]);

  return (
    <DrugUsageSearchContext.Provider value={value}>
      {children}
    </DrugUsageSearchContext.Provider>
  );
}

export function useDrugUsageSearch(): SearchState {
  const value = useContext(DrugUsageSearchContext);
  if (!value) throw new Error("useDrugUsageSearch must be used inside DrugUsageSearchProvider");
  return value;
}

export function DrugUsageSearchInput() {
  const { query, setQuery } = useDrugUsageSearch();

  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-semibold text-slate-700">ค้นหายา</span>
      <span className="relative block">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          placeholder="ค้นหาชื่อยา หรือรหัสยา..."
          className={`${inputClass} border-slate-200 bg-white pl-9 shadow-sm`}
          autoComplete="off"
        />
      </span>
    </label>
  );
}

export function DrugTypeMultiSelect({
  options,
  selected,
  primaryTypes,
}: {
  options: string[];
  selected: string[];
  primaryTypes: string[];
}) {
  const selectedSummary = selected.length
    ? selected.map((type) => `${type} ${drugTypeLabel(type)}`).join(", ")
    : "ยังไม่ได้เลือกหมวด";

  return (
    <div className="min-w-0">
      <span className="mb-1 block text-xs font-semibold text-slate-700">หมวดยา</span>
      <details className="group relative">
        <summary className={`${inputClass} flex cursor-pointer list-none items-center justify-between gap-2 border-slate-200 bg-white shadow-sm [&::-webkit-details-marker]:hidden`}>
          <span className="min-w-0 truncate text-left">{selectedSummary}</span>
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {options.map((type) => (
              <label
                key={type}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  name="types"
                  value={type}
                  defaultChecked={selected.includes(type)}
                  className="size-4 accent-[color:var(--color-brand)]"
                />
                <span className="min-w-0 flex-1 truncate">
                  {type} {drugTypeLabel(type)}
                </span>
                {!primaryTypes.includes(type) ? (
                  <span className="text-[11px] text-muted">ไม่ใช่ยา</span>
                ) : null}
              </label>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

export function DrugUsageReportViews({
  dateContext,
  listView,
  categoryView,
}: {
  dateContext: string;
  listView: ReactNode;
  categoryView: ReactNode;
}) {
  const [view, setView] = useState<"list" | "category">("list");

  return (
    <section className="mt-3 min-w-0 overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.065)]">
      <div className="flex min-h-[50px] items-end gap-1 border-b border-slate-200 px-3 sm:px-5" role="tablist" aria-label="มุมมองรายงานการใช้ยา">
        <button
          type="button"
          role="tab"
          aria-selected={view === "list"}
          onClick={() => setView("list")}
          className={`inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors ${
            view === "list"
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          <List aria-hidden className="size-4" />
          รายการยา
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "category"}
          onClick={() => setView("category")}
          className={`inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors ${
            view === "category"
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          <BarChart3 aria-hidden className="size-4" />
          สรุปตามหมวดยา
        </button>
      </div>

      {view === "list" ? (
        <div>
          <div className="border-b border-slate-100 px-4 py-2.5 sm:px-5">
            <h2 className="text-[15px] font-bold text-ink">รายงานรายการยาตามการใช้</h2>
            <p className="mt-0.5 text-xs text-muted">{dateContext}</p>
          </div>
          {listView}
        </div>
      ) : (
        categoryView
      )}
    </section>
  );
}
