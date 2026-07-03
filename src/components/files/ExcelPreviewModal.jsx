import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Download, Loader2, X } from 'lucide-react';
import { getClaimFileSignedUrl } from '../../lib/claimsApi.js';

const ROW_PREVIEW_LIMIT = 500;

/**
 * Read-only in-app spreadsheet preview of a stored claim file. Fetches a
 * short-lived signed URL (never a public Storage URL) and parses it
 * client-side with SheetJS — the preview never mutates the original file.
 * Large sheets are capped at ROW_PREVIEW_LIMIT rows so the browser never
 * freezes; a banner explains when a sheet was truncated.
 */
export default function ExcelPreviewModal({ open, onClose, filePath, meta }) {
  const [loading, setLoading] = useState(false);
  const [workbook, setWorkbook] = useState(null);
  const [activeSheet, setActiveSheet] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !filePath) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = await getClaimFileSignedUrl(filePath);
        if (cancelled) return;
        setDownloadUrl(url);
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        if (cancelled) return;
        setWorkbook(wb);
        setActiveSheet(wb.SheetNames[0]);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [open, filePath]);

  const sheetData = useMemo(() => {
    if (!workbook || !activeSheet) return null;
    const sheet = workbook.Sheets[activeSheet];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const totalRows = rows.length;
    const truncated = totalRows > ROW_PREVIEW_LIMIT;
    return { rows: rows.slice(0, ROW_PREVIEW_LIMIT), totalRows, truncated };
  }, [workbook, activeSheet]);

  if (!open) return null;

  const maxCols = sheetData ? Math.max(0, ...sheetData.rows.map((r) => r.length)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-navy">{meta?.filename ?? 'File Preview'}</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              {[meta?.facilityName, meta?.pharmacyName, meta?.claimDate, meta?.uploadedAt].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {downloadUrl && (
              <a href={downloadUrl} download={meta?.filename} className="btn-secondary px-3 py-1.5 text-xs">
                <Download className="h-3.5 w-3.5" /> Download Original File
              </a>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading preview...
          </div>
        )}

        {error && (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-danger">
            Could not load preview: {error}
          </div>
        )}

        {!loading && !error && workbook && (
          <>
            <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-100 bg-surface-alt px-4 py-2">
              {workbook.SheetNames.map((name) => (
                <button
                  key={name}
                  onClick={() => setActiveSheet(name)}
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium ${
                    activeSheet === name ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:bg-white/60'
                  }`}
                >
                  {name}
                </button>
              ))}
              <span className="ml-auto whitespace-nowrap px-2 text-xs text-gray-400">
                {workbook.SheetNames.length} sheet{workbook.SheetNames.length !== 1 ? 's' : ''} · {sheetData?.totalRows ?? 0} rows in &quot;{activeSheet}&quot;
              </span>
            </div>

            {sheetData?.truncated && (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-warning">
                Showing the first {ROW_PREVIEW_LIMIT.toLocaleString()} of {sheetData.totalRows.toLocaleString()} rows for performance. Download
                the original file for the full sheet.
              </div>
            )}

            <div className="flex-1 overflow-auto">
              <table className="border-collapse text-xs">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className="sticky left-0 z-20 border border-gray-200 bg-surface-alt px-2 py-1 text-gray-400"> </th>
                    {Array.from({ length: maxCols }).map((_, c) => (
                      <th key={c} className="border border-gray-200 bg-surface-alt px-3 py-1 font-semibold text-navy">
                        {XLSX.utils.encode_col(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheetData?.rows.map((row, r) => (
                    <tr key={r}>
                      <td className="sticky left-0 z-10 border border-gray-200 bg-surface-alt px-2 py-1 text-center text-gray-400">{r + 1}</td>
                      {Array.from({ length: maxCols }).map((_, c) => (
                        <td key={c} className="whitespace-nowrap border border-gray-100 px-3 py-1 text-navy">
                          {row[c] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
