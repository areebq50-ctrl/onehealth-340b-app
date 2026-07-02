import * as XLSX from 'xlsx';
import { cleanClaimRow } from '../lib/dataCleaning.js';

const NDC_HEADER_ALIASES = ['ndc', 'ndc code', 'ndc#', 'ndc number', 'ndc11'];
const DRUG_HEADER_ALIASES = ['drug name', 'drug', 'product name', 'product', 'description', 'item description'];
const QTY_HEADER_ALIASES = ['qty', 'quantity', 'qty dispensed', 'quantity dispensed', 'sum of qty', 'dispensed qty'];

function normalizeHeaderCell(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findColumnIndex(headerRow, aliases) {
  const normalized = headerRow.map(normalizeHeaderCell);
  // Exact match first.
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return idx;
  }
  // Fall back to "contains".
  for (let i = 0; i < normalized.length; i++) {
    if (aliases.some((alias) => normalized[i].includes(alias))) return i;
  }
  return -1;
}

/**
 * Scan the first N rows of a sheet (as array-of-arrays) to find the header
 * row — i.e. the first row that contains both an NDC-like column and a
 * qty-like column. Some source files have title rows above the real header.
 */
function findHeaderRowIndex(rows, maxScan = 15) {
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? [];
    const ndcIdx = findColumnIndex(row, NDC_HEADER_ALIASES);
    const qtyIdx = findColumnIndex(row, QTY_HEADER_ALIASES);
    if (ndcIdx >= 0 && qtyIdx >= 0) return i;
  }
  return -1;
}

/**
 * Pick the raw transaction sheet (never a pivot/summary sheet). Prefers a
 * sheet literally named "Sheet"; otherwise excludes anything that looks like
 * a pivot/summary/total tab and picks the sheet with the most data rows.
 */
function pickRawTransactionSheet(workbook) {
  const names = workbook.SheetNames;
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];

  const exact = names.find((n) => n.trim().toLowerCase() === 'sheet');
  if (exact) return exact;

  const candidates = names.filter((n) => !/pivot|summary|total/i.test(n));
  const pool = candidates.length > 0 ? candidates : names;

  let best = pool[0];
  let bestRowCount = -1;
  for (const name of pool) {
    const sheet = workbook.Sheets[name];
    const rowCount = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1:A1').e.r;
    if (rowCount > bestRowCount) {
      bestRowCount = rowCount;
      best = name;
    }
  }
  return best;
}

/**
 * Parse a raw claims .xlsx file into cleaned rows, applying every data
 * cleaning rule from the spec. Never throws on malformed data — bad rows are
 * collected in `skippedRows` with a human-readable reason, and the file is
 * only rejected outright if zero valid rows remain after cleaning.
 *
 * Returns:
 *   {
 *     error: string | null,          // set only for whole-file rejection
 *     sheetName: string | null,
 *     validRows: [{ ndcRaw, ndc, drugName, qty: Decimal, rowNumber }],
 *     skippedRows: [{ rowNumber, raw, reason }],
 *   }
 */
export function parseClaimsXlsx(arrayBuffer) {
  let workbook;
  try {
    workbook = XLSX.read(arrayBuffer, { type: 'array' });
  } catch (err) {
    return { error: `File could not be read as an Excel workbook: ${err.message}`, sheetName: null, validRows: [], skippedRows: [] };
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { error: 'The uploaded file contains no sheets.', sheetName: null, validRows: [], skippedRows: [] };
  }

  const sheetName = pickRawTransactionSheet(workbook);
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  if (rows.length === 0) {
    return { error: 'The selected sheet is completely empty.', sheetName, validRows: [], skippedRows: [] };
  }

  const headerRowIdx = findHeaderRowIndex(rows);
  if (headerRowIdx === -1) {
    return {
      error: 'Could not find a header row containing NDC and Qty columns. Verify this is the raw transaction sheet, not a pivot/summary tab.',
      sheetName,
      validRows: [],
      skippedRows: [],
    };
  }

  const headerRow = rows[headerRowIdx];
  const ndcCol = findColumnIndex(headerRow, NDC_HEADER_ALIASES);
  const drugCol = findColumnIndex(headerRow, DRUG_HEADER_ALIASES);
  const qtyCol = findColumnIndex(headerRow, QTY_HEADER_ALIASES);

  if (ndcCol === -1 || qtyCol === -1) {
    return { error: 'Required columns (NDC, Qty) are missing from this file.', sheetName, validRows: [], skippedRows: [] };
  }

  const validRows = [];
  const skippedRows = [];

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rowNumber = i + 1; // 1-indexed, matches what a user sees in Excel
    const isBlankRow = row.every((c) => String(c ?? '').trim() === '');
    if (isBlankRow) {
      skippedRows.push({ rowNumber, raw: row, reason: 'Row is completely blank' });
      continue;
    }

    const ndcRawCell = row[ndcCol];
    const drugRawCell = drugCol >= 0 ? row[drugCol] : '';
    const qtyRawCell = row[qtyCol];

    const cleaned = cleanClaimRow({ ndcRaw: ndcRawCell, drugName: drugRawCell, qtyRaw: qtyRawCell }, rowNumber);
    if (!cleaned.valid) {
      skippedRows.push({ rowNumber, raw: row, reason: cleaned.reason });
      continue;
    }

    validRows.push({ rowNumber, ...cleaned.row });
  }

  if (validRows.length === 0) {
    return {
      error: 'No valid rows remained after data cleaning (all rows were blank, Grand Total, #N/A, or zero qty). File rejected.',
      sheetName,
      validRows: [],
      skippedRows,
    };
  }

  return { error: null, sheetName, validRows, skippedRows };
}
