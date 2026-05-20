import { useMemo, useState, type ReactNode } from 'react';

export interface TableColumn<T> {
  key: string;
  label: string;
  /** When true, clicking the header toggles asc/desc sort by this column. */
  sortable?: boolean;
  /** Comparison value when sorting; defaults to render result if not provided. */
  sortValue?: (row: T) => string | number | null | undefined;
  render: (row: T) => ReactNode;
  /** Optional className for header + cell — handy for fixed widths. */
  className?: string;
  /** Right-align column header + cells (e.g. numeric). */
  align?: 'left' | 'right';
}

type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

interface TableProps<T> {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  /**
   * Default sort applied before the user clicks any header (td-liky3d).
   * The user's click on a sortable header overrides this. Pass `null` (or
   * omit) to use the row order as returned by the source.
   */
  initialSort?: SortState | null;
  /**
   * Controlled mode (cd-d68p): when both are supplied, Table renders rows
   * in the order it received them (no client-side resort) and delegates
   * sort-toggle clicks to the parent via onSortChange. Use this when the
   * source is already sorted server-side and re-sorting client-side
   * would mis-order page boundaries.
   */
  sort?: SortState | null;
  onSortChange?: (next: SortState) => void;
}

// Lightweight typed table. Sortable via header click, no external dep.
// If we hit 1k+ row scale where this stutters, swap for TanStack Table;
// at our scale (sessions <50, beads <200) plain map+sort is fine.
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  initialSort,
  sort: controlledSort,
  onSortChange,
}: TableProps<T>) {
  const isControlled = controlledSort !== undefined && onSortChange !== undefined;
  const [uncontrolledSort, setUncontrolledSort] = useState<SortState | null>(initialSort ?? null);
  const sort = isControlled ? controlledSort : uncontrolledSort;

  const sortedRows = useMemo(() => {
    // Controlled mode trusts the parent: rows are pre-sorted server-side.
    if (isControlled) return rows;
    if (sort === null) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col || !col.sortable) return rows;
    const getVal = col.sortValue ?? ((r: T) => String(col.render(r) ?? ''));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      if (av === bv) return 0;
      if (av === null || av === undefined) return -dir;
      if (bv === null || bv === undefined) return dir;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }, [rows, columns, sort, isControlled]);

  const toggleSort = (key: string) => {
    const cur = sort;
    const next: SortState =
      cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    if (isControlled) {
      onSortChange(next);
    } else {
      setUncontrolledSort(next);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm font-sans">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink-300 border-b border-ink-600">
            {columns.map((col) => {
              const isSorted = sort?.key === col.key;
              const align = col.align === 'right' ? 'text-right' : 'text-left';
              return (
                <th
                  key={col.key}
                  scope="col"
                  className={`px-3 py-2 font-medium select-none ${align} ${col.className ?? ''}`}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-sm"
                    >
                      {col.label}
                      {isSorted && (
                        <span aria-hidden className="text-accent-500">
                          {sort?.dir === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-6 text-center text-ink-300 italic"
              >
                {empty ?? 'No data'}
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-ink-700/60 ${
                  onRowClick
                    ? 'cursor-pointer hover:bg-ink-700/40 focus-within:bg-ink-700/40'
                    : ''
                }`}
              >
                {columns.map((col) => {
                  const align = col.align === 'right' ? 'text-right' : 'text-left';
                  return (
                    <td
                      key={col.key}
                      className={`px-3 py-2 align-top ${align} ${col.className ?? ''}`}
                    >
                      {col.render(row)}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
