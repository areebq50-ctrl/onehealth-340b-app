import { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, Search } from 'lucide-react';
import EmptyState from './EmptyState.jsx';

/**
 * Generic striped / sticky-header / sortable / searchable / paginated table.
 *
 * columns: [{ key, label, sortable, render(row), accessor(row) }]
 * accessor is used for search + sort; render is used for display (falls back to accessor).
 */
export default function DataTable({
  columns,
  rows,
  rowKey = (row) => row.id,
  searchPlaceholder = 'Search...',
  pageSize = 25,
  emptyTitle = 'No data yet',
  emptyMessage = 'Nothing to show here.',
  onRowClick,
  rowClassName,
  initialSearch = '',
}) {
  const [search, setSearch] = useState(initialSearch);
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((row) =>
      columns.some((col) => {
        const val = col.accessor ? col.accessor(row) : row[col.key];
        return String(val ?? '').toLowerCase().includes(q);
      })
    );
  }, [rows, search, columns]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const accessor = col.accessor ?? ((row) => row[col.key]);
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv), undefined, { numeric: true });
    });
    if (sortDir === 'desc') copy.reverse();
    return copy;
  }, [filtered, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-gray-100 p-4">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            className="input-field pl-9"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <span className="whitespace-nowrap text-sm text-gray-500">{sorted.length.toLocaleString()} rows</span>
      </div>

      {rows.length === 0 ? (
        <div className="p-6">
          <EmptyState title={emptyTitle} message={emptyMessage} />
        </div>
      ) : (
        <>
          <div className="max-h-[65vh] overflow-auto">
            <table className="w-full min-w-max text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface-alt">
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className={`whitespace-nowrap border-b border-gray-200 px-4 py-3 font-semibold text-navy ${
                        col.sortable ? 'cursor-pointer select-none hover:bg-gray-100' : ''
                      }`}
                      onClick={() => col.sortable && toggleSort(col.key)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {col.sortable && sortKey === col.key && (
                          sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row, i) => (
                  <tr
                    key={rowKey(row)}
                    onClick={() => onRowClick?.(row)}
                    className={`${i % 2 === 0 ? 'bg-white' : 'bg-surface-alt'} ${
                      onRowClick ? 'cursor-pointer hover:bg-teal-50' : ''
                    } ${rowClassName?.(row) ?? ''}`}
                  >
                    {columns.map((col) => (
                      <td key={col.key} className="whitespace-nowrap border-b border-gray-100 px-4 py-3 text-navy">
                        {col.render ? col.render(row) : (col.accessor ? col.accessor(row) : row[col.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm">
              <span className="text-gray-500">
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  className="btn-secondary px-3 py-1.5"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <button
                  className="btn-secondary px-3 py-1.5"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
