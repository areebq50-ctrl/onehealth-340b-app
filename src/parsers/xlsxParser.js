import * as XLSX from 'xlsx';
import { cleanClaimRow } from '../lib/dataCleaning.js';
import { normalizeExcelDateCell, toDecimal } from '../lib/calculations.js';

const NDC_HEADER_ALIASES = ['ndc', 'ndc code', 'ndc#', 'ndc number', 'ndc11'];
const DRUG_HEADER_ALIASES = ['drug name', 'drug', 'product name', 'product', 'description', 'item description'];
const QTY_HEADER_ALIASES = ['qty', 'quantity', 'qty dispensed', 'quantity dispensed', 'sum of qty', 'dispensed qty'];

// Optional RX-level ledger columns — captured as pass-through detail for the
// "All Claims" tab (claim_raw_lines) when present. Never required; missing
// columns just leave the field null. Aliases match the real reference
// workbook's exact headers (Refill No., RX#, Primary BIN, etc.).
const LEDGER_COLUMN_ALIASES = {
  refillNo: ['refill no.', 'refill no', 'refill number'],
  refillsAuth: ['refills auth.', 'refills auth', 'refills authorized'],
  refillsRemain: ['refills remain.', 'refills remain', 'refills remaining'],
  dateFilled: ['date filled'],
  dateWritten: ['date written'],
  rxNumber: ['rx#', 'rx #', 'rx number'],
  daysSupply: ['ds', 'days supply'],
  primaryPaid: ['primary paid'],
  patientPaid: ['patient paid'],
  tax: ['tax'],
  fee: ['fee'],
  totalPaid: ['total'],
  primaryPayer: ['primary'],
  bin: ['primary bin', 'bin'],
  pcn: ['primary pcn', 'pcn'],
  groupCode: ['primary group', 'group'],
  memberId: ['primary id', 'member id'],
  scc: ['scc'],
  prescriber: ['prescriber'],
  prescriberNpi: ['prescriber npi'],
};

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

/** Best-effort integer parse — returns null (not NaN/0) for anything unparseable, so callers can tell "absent" from "zero". */
function toIntOrNull(value) {
  const d = toDecimal(value);
  return d === null ? null : d.toDecimalPlaces(0).toNumber();
}

function toNumOrNull(value) {
  const d = toDecimal(value);
  return d === null ? null : d.toNumber();
}

/** Text field preserving leading zeros (RX#, BIN, PCN, Group, Member ID) — always stringified, never left as a coerced number. */
function toTextOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

/**
 * Pulls the optional RX-level ledger fields for one row into a flat object
 * (all pass-through, none of these gate row validity). Date columns go
 * through normalizeExcelDateCell so serials from real workbooks convert
 * correctly; identifier columns are always stringified to preserve leading
 * zeros.
 */
function extractLedgerFields(row, ledgerCols) {
  const cell = (field) => (ledgerCols[field] >= 0 ? row[ledgerCols[field]] : null);
  return {
    refillNo: toIntOrNull(cell('refillNo')),
    refillsAuth: toIntOrNull(cell('refillsAuth')),
    refillsRemain: toIntOrNull(cell('refillsRemain')),
    dateFilled: normalizeExcelDateCell(cell('dateFilled')),
    dateWritten: normalizeExcelDateCell(cell('dateWritten')),
    rxNumber: toTextOrNull(cell('rxNumber')),
    daysSupply: toNumOrNull(cell('daysSupply')),
    primaryPaid: toNumOrNull(cell('primaryPaid')),
    patientPaid: toNumOrNull(cell('patientPaid')),
    tax: toNumOrNull(cell('tax')),
    fee: toNumOrNull(cell('fee')),
    totalPaid: toNumOrNull(cell('totalPaid')),
    primaryPayer: toTextOrNull(cell('primaryPayer')),
    bin: toTextOrNull(cell('bin')),
    pcn: toTextOrNull(cell('pcn')),
    groupCode: toTextOrNull(cell('groupCode')),
    memberId: toTextOrNull(cell('memberId')),
    scc: toTextOrNull(cell('scc')),
    prescriber: toTextOrNull(cell('prescriber')),
    prescriberNpi: toTextOrNull(cell('prescriberNpi')),
  };
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

  const ledgerCols = {};
  for (const [field, aliases] of Object.entries(LEDGER_COLUMN_ALIASES)) {
    ledgerCols[field] = findColumnIndex(headerRow, aliases);
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

    validRows.push({ rowNumber, ...cleaned.row, ledger: extractLedgerFields(row, ledgerCols) });
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
