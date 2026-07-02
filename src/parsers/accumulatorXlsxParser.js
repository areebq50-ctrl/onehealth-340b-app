import * as XLSX from 'xlsx';
import { normalizeNdc } from '../lib/ndc.js';
import { toDecimal, normalizeExcelDateCell } from '../lib/calculations.js';

const COLUMN_ALIASES = {
  ndc: ['ndc', 'ndc code', 'ndc#', 'ndc number'],
  productName: ['product name', 'drug name', 'product', 'description'],
  packSize: ['pack size', 'packsize'],
  qtyOnHand: ['qty on hand', 'quantity on hand', 'qty', 'on hand'],
  expDay: ['exp day', 'expiration', 'exp date', 'expiry'],
  price340b: ['340b price', 'price 340b', 'price'],
  ppu340b: ['340b ppu', 'ppu 340b', 'ppu'],
  cin: ['cin'],
  manufacturer: ['manufacturer', 'mfr'],
};

const REQUIRED_FIELDS = ['ndc', 'productName', 'qtyOnHand'];

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
 * Parses an admin-uploaded accumulator starting-balance file. Validates that
 * all required columns (NDC, Product Name, Qty on Hand) are present before
 * accepting the file, and returns a preview the admin must confirm before
 * anything is written to the database.
 */
export function parseAccumulatorXlsx(arrayBuffer) {
  let workbook;
  try {
    workbook = XLSX.read(arrayBuffer, { type: 'array' });
  } catch (err) {
    return { error: `File could not be read as an Excel workbook: ${err.message}`, rows: [], skippedRows: [] };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { error: 'The uploaded file contains no sheets.', rows: [], skippedRows: [] };

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (rawRows.length === 0) return { error: 'The sheet is completely empty.', rows: [], skippedRows: [] };

  const headerRow = rawRows[0];
  const colIndex = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    colIndex[field] = findColumnIndex(headerRow, aliases);
  }

  const missingRequired = REQUIRED_FIELDS.filter((f) => colIndex[f] === -1);
  if (missingRequired.length > 0) {
    return {
      error: `Missing required column(s): ${missingRequired.join(', ')}. Verify the file has NDC, Product Name, and Qty on Hand columns.`,
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
    const qtyOnHand = toDecimal(qtyOnHandRaw);
    if (qtyOnHand === null) {
      skippedRows.push({ rowNumber, reason: `Invalid Qty on Hand "${qtyOnHandRaw}"` });
      continue;
    }

    rows.push({
      ndc,
      productName: String(row[colIndex.productName] ?? '').trim() || '(unnamed)',
      packSize: colIndex.packSize >= 0 ? toDecimal(row[colIndex.packSize])?.toString() ?? null : null,
      qtyOnHand: qtyOnHand.toString(),
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

  return { error: null, rows, skippedRows };
}
