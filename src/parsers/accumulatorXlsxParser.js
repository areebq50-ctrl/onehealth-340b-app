import * as XLSX from 'xlsx';
import { normalizeNdc } from '../lib/ndc.js';
import { toDecimal, normalizeExcelDateCell } from '../lib/calculations.js';

const COLUMN_ALIASES = {
  ndc: ['ndc', 'ndc code', 'ndc#', 'ndc number'],
  productName: ['product name', 'drug name', 'product', 'description'],
  packSize: ['pack size', 'packsize'],
  expDay: ['exp day', 'expiration', 'exp date', 'expiry'],
  price340b: ['340b price', 'price 340b', 'price', 'contract price'],
  ppu340b: ['340b ppu', 'ppu 340b', 'ppu', 'unit cost', 'cost per unit', 'per unit cost'],
  cin: ['cin'],
  manufacturer: ['manufacturer', 'mfr'],
};

// Two DIFFERENT sign conventions show up in real pharmacy spreadsheets for
// "how much of this drug is on hand":
//   - Raw physical count columns — positive = units you actually have.
//   - Running-ledger "New Balance" columns, which track a deficit/surplus
//     figure where NEGATIVE means surplus/over-replenished (dispensing is
//     ADDED to New Balance, the opposite of the raw-count convention).
// accumulator.qty_on_hand is deficit-framed (negative = surplus, positive =
// shortage) — the SAME convention as a "New Balance" column, not a raw
// physical count. So a raw physical-count-style column needs negating on
// import to match; a "New Balance"-style column already matches as-is.
// The column HEADER TEXT is only a hint, not proof, of which convention a
// given file uses — two real source files have used the exact same header
// wording ("Qty on Hand") for opposite conventions. So this module never
// silently negates based on the header match: it only supplies a
// best-guess default (qtyOnHandSuggestNegate) and the raw, un-negated
// value per row; the importing UI must show the admin which convention was
// guessed and let them confirm or flip it before anything is negated.
const QTY_ON_HAND_RAW_ALIASES = ['qty on hand', 'quantity on hand', 'qty', 'on hand'];
const NEW_BALANCE_ALIASES = ['new balance'];

const REQUIRED_FIELDS = ['ndc', 'productName'];

// Excel workbooks routinely carry a "used range" (sheet['!ref']) far wider
// than any real data — a stray fill color or border applied across a whole
// swath of empty columns is enough to push it out thousands of columns.
// sheet_to_json with no range limit materializes every cell in that range,
// which turns a few-hundred-row sheet into tens of millions of phantom
// empty cells and multi-second parses. No real accumulator file needs more
// than a couple dozen columns, so the read is capped well above that.
const MAX_REALISTIC_COLUMNS = 60;

function boundedRange(sheet) {
  if (!sheet['!ref']) return undefined;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (range.e.c <= MAX_REALISTIC_COLUMNS) return sheet['!ref'];
  range.e.c = MAX_REALISTIC_COLUMNS;
  return XLSX.utils.encode_range(range);
}

function normalizeHeaderCell(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findColumnIndex(headerRow, aliases) {
  const normalized = headerRow.map(normalizeHeaderCell);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return idx;
  }
  for (let i = 0; i < normalized.length; i++) {
    if (aliases.some((alias) => normalized[i].includes(alias))) return i;
  }
  return -1;
}

/**
 * Reads an .xlsx/.xls file ONE time into an in-memory workbook object, plus
 * its sheet names + row counts, so the caller can show a sheet picker before
 * committing to a parse — and so switching the picked sheet afterward never
 * re-reads the raw file bytes again (parsing an 800-row, 4-sheet workbook
 * twice was visibly slow; this makes the second-and-later parse instant).
 */
export function readAccumulatorWorkbook(arrayBuffer) {
  try {
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const ref = sheet['!ref'];
      const rowCount = ref ? XLSX.utils.decode_range(ref).e.r : 0;
      return { name, rowCount };
    });
    return { workbook, sheets, error: null };
  } catch (err) {
    return { workbook: null, sheets: [], error: `File could not be read as an Excel workbook: ${err.message}` };
  }
}

/**
 * Parses one sheet of an already-read workbook (see readAccumulatorWorkbook)
 * into accumulator rows, validating required columns and returning a
 * preview the admin must confirm before anything is written to the
 * database. `sheetName` must be supplied by the caller rather than
 * defaulted, so a multi-sheet workbook never gets silently parsed from the
 * wrong sheet — many real accumulator workbooks accumulate one updated
 * sheet per revision through the month, so the first sheet is reliably the
 * STALEST one, not the newest.
 */
export function parseAccumulatorSheet(workbook, sheetName) {
  if (!sheetName || !workbook?.Sheets?.[sheetName]) {
    return { error: 'The uploaded file contains no sheets.', rows: [], skippedRows: [] };
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', range: boundedRange(sheet) });
  if (rawRows.length === 0) return { error: 'The sheet is completely empty.', rows: [], skippedRows: [] };

  const headerRow = rawRows[0];
  const colIndex = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    colIndex[field] = findColumnIndex(headerRow, aliases);
  }

  // Prefer a raw physical "Qty on Hand" column; only fall back to a
  // "New Balance" ledger column if no raw column exists. Since the app's
  // native convention is deficit-framed (like "New Balance"), a raw
  // physical-count column is the one that needs negating by default now.
  const rawQtyIdx = findColumnIndex(headerRow, QTY_ON_HAND_RAW_ALIASES);
  const newBalanceIdx = findColumnIndex(headerRow, NEW_BALANCE_ALIASES);
  const qtyOnHandSuggestNegate = rawQtyIdx >= 0;
  colIndex.qtyOnHand = rawQtyIdx >= 0 ? rawQtyIdx : newBalanceIdx;

  const missingRequired = REQUIRED_FIELDS.filter((f) => colIndex[f] === -1);
  if (missingRequired.length > 0 || colIndex.qtyOnHand === -1) {
    const missing = [...missingRequired, ...(colIndex.qtyOnHand === -1 ? ['qtyOnHand'] : [])];
    return {
      error: `Missing required column(s): ${missing.join(', ')}. Verify the file has NDC, Product Name, and a Qty on Hand (or New Balance) column.`,
      rows: [],
      skippedRows: [],
    };
  }

  const rows = [];
  const skippedRows = [];

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i] ?? [];
    const rowNumber = i + 1;
    const isBlank = row.every((c) => String(c ?? '').trim() === '');
    if (isBlank) continue;

    const ndcRaw = row[colIndex.ndc];
    const ndc = normalizeNdc(ndcRaw);
    if (ndc === null) {
      skippedRows.push({ rowNumber, reason: `Invalid NDC "${ndcRaw}"` });
      continue;
    }

    const qtyOnHandCell = row[colIndex.qtyOnHand];
    const qtyOnHandParsed = toDecimal(qtyOnHandCell);
    if (qtyOnHandParsed === null) {
      skippedRows.push({ rowNumber, reason: `Invalid Qty on Hand "${qtyOnHandCell}"` });
      continue;
    }

    rows.push({
      ndc,
      productName: String(row[colIndex.productName] ?? '').trim() || '(unnamed)',
      packSize: colIndex.packSize >= 0 ? toDecimal(row[colIndex.packSize])?.toString() ?? null : null,
      // Deliberately NOT negated here, and no "negativeQty" flag computed
      // here either. Column NAME alone ("Qty on Hand" vs "New Balance") is
      // not a reliable signal of sign convention — two source files can use
      // the identical header text for opposite meanings (confirmed by a
      // real user file where a column matching the "raw" aliases actually
      // used the deficit/surplus convention). The caller (ImportModal) asks
      // the admin to confirm the convention explicitly — using
      // qtyOnHandSuggestNegate only as the pre-selected default — and
      // negates (or not) client-side from this raw value accordingly.
      qtyOnHandRaw: qtyOnHandParsed.toString(),
      expDay: colIndex.expDay >= 0 ? normalizeExcelDateCell(row[colIndex.expDay]) : null,
      price340b: colIndex.price340b >= 0 ? toDecimal(row[colIndex.price340b])?.toString() ?? null : null,
      ppu340b: colIndex.ppu340b >= 0 ? toDecimal(row[colIndex.ppu340b])?.toString() ?? null : null,
      cin: colIndex.cin >= 0 ? String(row[colIndex.cin] ?? '').trim() : null,
      manufacturer: colIndex.manufacturer >= 0 ? String(row[colIndex.manufacturer] ?? '').trim() : null,
    });
  }

  if (rows.length === 0) {
    return { error: 'No valid rows found after validation.', rows: [], skippedRows };
  }

  // Surfaces exactly which optional columns were (and weren't) found, and
  // under what header text — so a column the parser didn't recognize (e.g.
  // a 340B price column titled something COLUMN_ALIASES doesn't cover)
  // shows up as a visible "not found" at import time, instead of silently
  // importing every row with a blank price and only being noticed later on
  // an order sheet showing "$0.00" everywhere with no explanation why.
  const detectedColumns = {
    price340b: colIndex.price340b >= 0 ? String(headerRow[colIndex.price340b] ?? '').trim() : null,
    ppu340b: colIndex.ppu340b >= 0 ? String(headerRow[colIndex.ppu340b] ?? '').trim() : null,
    expDay: colIndex.expDay >= 0 ? String(headerRow[colIndex.expDay] ?? '').trim() : null,
    cin: colIndex.cin >= 0 ? String(headerRow[colIndex.cin] ?? '').trim() : null,
    manufacturer: colIndex.manufacturer >= 0 ? String(headerRow[colIndex.manufacturer] ?? '').trim() : null,
  };

  return {
    error: null,
    rows,
    skippedRows,
    detectedColumns,
    // Best-effort DEFAULT for the convention toggle — a raw "Qty on Hand"
    // -like header suggests negating (to match the app's native deficit-
    // framed convention), a "New Balance"-like header (with no raw column
    // present) suggests importing as-is. Always admin-overridable in the
    // UI, never applied silently.
    qtyOnHandSuggestNegate,
    qtyOnHandColumnLabel: String(headerRow[colIndex.qtyOnHand] ?? '').trim(),
  };
}
