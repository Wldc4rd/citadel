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

interface TableProps<T> {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
}

type SortDir = 'asc' | 'desc';
interface SortState {
  key: string;
  dir: SortDir;
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
}: TableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(null);

  const sortedRows = useMemo(() => {
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
  }, [rows, columns, sort]);

  const toggleSort = (key: string) => {
    setSort((cur) => {
      if (cur?.key !== key) return { key, dir: 'asc' };
      return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
    });
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
