"use client";

import { useMemo, useState, type ReactNode } from "react";

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;

// Spreadsheet-style column sorting. Each accessor returns a comparable value for a
// row (number, string, or null) — nulls always sort last. A freshly clicked column
// starts descending ("biggest first"); clicking the active column flips direction.
export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => number | string | null>,
  initial?: { key: string; dir: SortDir }
) {
  const [sort, setSort] = useState<SortState>(initial ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = accessors[sort.key];
    if (!get) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // nulls last, regardless of direction
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, accessors, sort]);

  const toggle = (key: string) =>
    setSort((p) => (p?.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  return { sorted, sort, toggle };
}

// A table header cell. Pass a `sortKey` to make it clickable with a direction arrow;
// omit it for a plain (non-sortable) header.
export function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  title,
  className,
}: {
  label: ReactNode;
  sortKey?: string;
  sort: SortState;
  onSort: (key: string) => void;
  title?: string;
  className?: string;
}) {
  const sortable = !!sortKey;
  const active = sortable && sort?.key === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : undefined}
      className={`${className ?? ""} ${sortable ? "select-none" : ""}`}
    >
      {sortable ? (
        // a real <button> so the column is keyboard-operable; inherits the th's font/colour
        <button
          type="button"
          title={title ?? "click to sort"}
          onClick={() => onSort(sortKey!)}
          className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-[#8b949e] focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60"
        >
          {label}
          <span className={active ? "text-[#58a6ff]" : "text-[#30363d]"} aria-hidden="true">
            {active ? (sort?.dir === "asc" ? "▲" : "▼") : "↕"}
          </span>
        </button>
      ) : (
        <span title={title} className="inline-flex items-center gap-1">
          {label}
        </span>
      )}
    </th>
  );
}
