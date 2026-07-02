import { toDecimal } from './calculations.js';
import { normalizeNdc } from './ndc.js';

const REJECT_NDC_VALUES = new Set(['', 'blank', '(blank)', 'grand total', 'total', '#n/a', 'n/a']);
const REJECT_DRUG_VALUES = new Set(['', '#n/a', 'n/a', 'blank', '(blank)']);

/**
 * Shared row-cleaning rules applied to every claim row regardless of source
 * (.xlsx raw sheet or PDF extraction). Never throws — always returns either
 * a cleaned row or a skip reason, so callers can build the "Skipped Rows"
 * panel without losing any input.
 */
export function cleanClaimRow({ ndcRaw, drugName, qtyRaw }, rowNumber) {
  const ndcNormalizedForReject = String(ndcRaw ?? '').trim().toLowerCase();
  if (REJECT_NDC_VALUES.has(ndcNormalizedForReject)) {
    return { valid: false, rowNumber, raw: { ndcRaw, drugName, qtyRaw }, reason: `NDC is blank/Grand Total/invalid ("${ndcRaw}")` };
  }

  const ndc = normalizeNdc(ndcRaw);
  if (ndc === null) {
    return { valid: false, rowNumber, raw: { ndcRaw, drugName, qtyRaw }, reason: `NDC "${ndcRaw}" is not a valid/numeric NDC` };
  }

  const drugNormalized = String(drugName ?? '').trim().toLowerCase();
  if (REJECT_DRUG_VALUES.has(drugNormalized)) {
    return { valid: false, rowNumber, raw: { ndcRaw, drugName, qtyRaw }, reason: `Drug Name is blank or #N/A ("${drugName}")` };
  }

  const qty = toDecimal(qtyRaw);
  if (qty === null) {
    return { valid: false, rowNumber, raw: { ndcRaw, drugName, qtyRaw }, reason: `Qty "${qtyRaw}" is blank or non-numeric` };
  }
  if (qty.isZero()) {
    return { valid: false, rowNumber, raw: { ndcRaw, drugName, qtyRaw }, reason: 'Qty is zero' };
  }

  return {
    valid: true,
    rowNumber,
    row: { ndcRaw: String(ndcRaw ?? ''), ndc, drugName: String(drugName ?? '').trim() || '(unnamed)', qty },
  };
}

/** Runs cleanClaimRow over an array and splits into validRows / skippedRows, matching the xlsx parser's output shape. */
export function cleanClaimRows(rawRows) {
  const validRows = [];
  const skippedRows = [];
  rawRows.forEach((raw, i) => {
    const result = cleanClaimRow(raw, i + 1);
    if (result.valid) validRows.push(result.row);
    else skippedRows.push({ rowNumber: result.rowNumber, raw: result.raw, reason: result.reason });
  });
  return { validRows, skippedRows };
}

/**
 * Pivot: group cleaned rows by normalized NDC, summing Qty with decimal.js.
 * Example: [{ndc:'00054032656',qty:30,drugName:'AMOX'},{ndc:'00054032656',qty:60,drugName:'AMOX'}]
 *       -> [{ndc:'00054032656', drugName:'AMOX', totalQty: 90 (Decimal)}]
 */
export function pivotByNdc(validRows) {
  const map = new Map();
  for (const row of validRows) {
    const existing = map.get(row.ndc);
    if (existing) {
      existing.totalQty = existing.totalQty.plus(row.qty);
      existing.rowCount += 1;
    } else {
      map.set(row.ndc, { ndc: row.ndc, drugName: row.drugName, totalQty: row.qty, rowCount: 1 });
    }
  }
  return Array.from(map.values());
}
