import * as XLSX from 'xlsx';
import { normalizeNdc } from '../lib/ndc.js';
import { toDecimal, normalizeExcelDateCell } from '../lib/calculations.js';

const COLUMN_ALIASES = {
  ndc: ['ndc', 'ndc code', 'ndc#', 'ndc number'],
  productName: ['product name', 'drug name', 'product', 'description'],
  packSize: ['pack size', 'packsize'],
  expDay: ['exp day', 'expiration', 'exp date', 'expiry'],
  price340b: ['340b price', 'price 340b', 'price'],
  ppu340b: ['340b ppu', 'ppu 340b', 'ppu'],
  cin: ['cin'],
  manufacturer: ['manufacturer', 'mfr'],
};

// Two DIFFERENT sign conventions show up in real pharmacy spreadsheets for
// "how much of this drug is on hand":
//   - Raw physical count columns ("Qty on Hand") — positive = units you
//     actually have. This is what accumulator.qty_on_hand stores.
//   - Running-ledger "New Balance" columns, which track a deficit/surplus
//     figure where NEGATIVE means surplus/over-replenished (confirmed
//     against a real reference workbook's own formulas: dispensing is
//     ADDED to New Balance, the opposite of the raw-count convention,
//     because New Balance is the negation of the raw physical count).
// Importing a "New Balance" value as-is into qty_on_hand silently flips
// every future calculation's sign, so it's negated on the way in instead.
const QTY_ON_HAND_RAW_ALIASES = ['qty on hand', 'quantity on hand', 'qty', 'on hand'];
const NEW_BALANCE_ALIASES = ['new balance'];

const REQUIRED_FIELDS = ['ndc', 'productName'];

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
 * Reads just the sheet names + row counts from a workbook, so the caller can
 * ask the admin which one to import BEFORE parsing it. Many real pharmacy
 * accumulator workbooks accumulate one sheet per update through the month
 * (e.g. "Master 06_05", "New Accumulator 6_16", "New Accumulator 6_22") —
 * silently picking the first one is silently picking the STALEST one, which
 * is exactly backwards. Never guess for a multi-sheet workbook.
 */
export function listAccumulatorXlsxSheets(arrayBuffer) {
  try {
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const ref = sheet['!ref'];
      const rowCount = ref ? XLSX.utils.decode_range(ref).e.r : 0;
      return { name, rowCount };
    });
  } catch {
    return [];
  }
}

/**
 * Parses an admin-uploaded accumulator starting-balance file. Validates that
 * all required columns (NDC, Product Name, Qty on Hand) are present before
 * accepting the file, and returns a preview the admin must confirm before
 * anything is written to the database. `sheetName` must be supplied by the
 * caller (see listAccumulatorXlsxSheets) rather than defaulted, so a
 * multi-sheet workbook never gets silently parsed from the wrong sheet.
 */
export function parseAccumulatorXlsx(arrayBuffer, sheetName) {
  let workbook;
  try {
    workbook = XLSX.read(arrayBuffer, { type: 'array' });
  } catch (err) {
    return { error: `File could not be read as an Excel workbook: ${err.message}`, rows: [], skippedRows: [] };
  }

  if (!sheetName) sheetName = workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) {
    return { error: 'The uploaded file contains no sheets.', rows: [], skippedRows: [] };
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (rawRows.length === 0) return { error: 'The sheet is completely empty.', rows: [], skippedRows: [] };

  const headerRow = rawRows[0];
  const colIndex = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    colIndex[field] = findColumnIndex(headerRow, aliases);
  }

  // Prefer a raw physical "Qty on Hand" column; only fall back to a
  // "New Balance" ledger column (negated on read) if no raw column exists.
  const rawQtyIdx = findColumnIndex(headerRow, QTY_ON_HAND_RAW_ALIASES);
  const newBalanceIdx = findColumnIndex(headerRow, NEW_BALANCE_ALIASES);
  const qtyOnHandIsNegated = rawQtyIdx === -1 && newBalanceIdx >= 0;
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

    const qtyOnHandRaw = row[colIndex.qtyOnHand];
    let qtyOnHand = toDecimal(qtyOnHandRaw);
    if (qtyOnHand === null) {
      skippedRows.push({ rowNumber, reason: `Invalid Qty on Hand "${qtyOnHandRaw}"` });
      continue;
    }
    if (qtyOnHandIsNegated) qtyOnHand = qtyOnHand.negated();

    rows.push({
      ndc,
      productName: String(row[colIndex.productName] ?? '').trim() || '(unnamed)',
      packSize: colIndex.packSize >= 0 ? toDecimal(row[colIndex.packSize])?.toString() ?? null : null,
      qtyOnHand: qtyOnHand.toString(),
      // A TRUE starting balance is a physical count and should essentially
      // never be negative — a negative qty_on_hand only ever makes sense as
      // a DERIVED "new balance" after dispensing exceeds supply, never as an
      // imported starting figure. Flagged (not excluded) so the import
      // preview can surface it instead of silently importing a sign error.
      // Decimal.js preserves a sign bit on negated zero ("-0"), so
      // isNegative() alone would misflag every zero-balance row that went
      // through the New Balance negation path above — exclude exact zero.
      negativeQty: qtyOnHand.isNegative() && !qtyOnHand.isZero(),
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

  return {
    error: null,
    rows,
    skippedRows,
    qtyOnHandIsNegated,
    qtyOnHandColumnLabel: String(headerRow[colIndex.qtyOnHand] ?? '').trim(),
  };
}
