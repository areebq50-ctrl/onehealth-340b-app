/**
 * All monetary / quantity / pack calculations for the 340B platform.
 *
 * Rule: NEVER use native JS *, /, +, - on money/quantity/pack values.
 * Every function below uses decimal.js exclusively, carries full precision
 * through the calculation chain, and only rounds at the boundary documented
 * in each function's comment (storage = 4dp, display/export = 2dp).
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Storage precision for currency/qty fields persisted to Postgres numeric columns. */
export const STORAGE_DP = 4;
/** Human-facing display / export precision for dollar amounts. */
export const DISPLAY_DP = 2;

/**
 * Coerce any input (number, numeric string, Decimal) into a Decimal.
 * Returns null instead of throwing when the value is not a finite number,
 * so callers can flag the row instead of crashing the whole batch.
 */
export function toDecimal(value) {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  try {
    const d = new Decimal(value);
    if (!d.isFinite()) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Packs Dispensed = Total Qty Dispensed ÷ Pack Size
 *
 * Example: qty=90, packSize=30  -> 90 ÷ 30 = 3
 * Example: qty=45, packSize=10  -> 45 ÷ 10 = 4.5
 *
 * If packSize is 0, null, missing, or non-numeric, this NEVER divides —
 * it returns { value: null, flagged: true } so the caller can route the
 * row to manual review instead of computing garbage or throwing.
 */
export function packsDispensed(qty, packSize) {
  const qtyD = toDecimal(qty);
  const packSizeD = toDecimal(packSize);

  if (qtyD === null) return { value: null, flagged: true, reason: 'Qty is missing or non-numeric' };
  if (packSizeD === null) return { value: null, flagged: true, reason: 'Pack Size is missing or non-numeric' };
  if (packSizeD.isZero()) return { value: null, flagged: true, reason: 'Pack Size is zero — cannot divide by zero' };

  const value = qtyD.dividedBy(packSizeD);
  return { value, flagged: false, reason: null };
}

/**
 * Reimbursement Owed = Total Qty Dispensed × 340B PPU
 *
 * Example: qty=30, ppu=45.6789 -> 30 × 45.6789 = 1370.367  (stored as 1370.3670, displayed as $1,370.37)
 * Example: qty=1,  ppu=0.5     -> 1 × 0.5      = 0.5        (stored as 0.5000,    displayed as $0.50)
 *
 * Full precision is carried through; rounding only happens where the caller
 * explicitly asks for storage-precision or display-precision output.
 */
export function reimbursementOwed(qty, ppu) {
  const qtyD = toDecimal(qty);
  const ppuD = toDecimal(ppu);
  if (qtyD === null || ppuD === null) return null;
  return qtyD.times(ppuD);
}

/**
 * New Qty on Hand = Prior Qty on Hand − Total Qty Dispensed
 *
 * Example: prior=500, dispensed=90  -> 500 − 90  = 410   (isNegative: false)
 * Example: prior=40,  dispensed=90  -> 40  − 90  = -50   (isNegative: true — must be flagged red in UI, never blocked)
 *
 * A negative result is a legitimate real-world scenario (over-dispensing
 * relative to recorded on-hand) and must be surfaced, not hidden or clamped.
 */
export function newQtyOnHand(priorQty, dispensedQty) {
  const priorD = toDecimal(priorQty);
  const dispensedD = toDecimal(dispensedQty);
  if (priorD === null || dispensedD === null) {
    return { value: null, isNegative: false };
  }
  const value = priorD.minus(dispensedD);
  return { value, isNegative: value.isNegative() };
}

/**
 * Packs On Hand = Qty On Hand ÷ Pack Size  (used during month rollover)
 * Example: qtyOnHand=410, packSize=30 -> 13.666666...
 * Same zero/null guard as packsDispensed.
 */
export function packsOnHand(qtyOnHand, packSize) {
  return packsDispensed(qtyOnHand, packSize);
}

/**
 * Cost On Hand (340B) = Qty On Hand × 340B PPU  (used during month rollover)
 * Example: qtyOnHand=410, ppu=45.6789 -> 18728.349
 */
export function costOnHand340b(qtyOnHand, ppu) {
  return reimbursementOwed(qtyOnHand, ppu);
}

/** Round a Decimal to storage precision (4dp). Only call at the point of writing to the DB. */
export function toStorage(decimalValue) {
  if (decimalValue === null || decimalValue === undefined) return null;
  return toDecimal(decimalValue)?.toDecimalPlaces(STORAGE_DP, Decimal.ROUND_HALF_UP) ?? null;
}

/** Round a Decimal to display precision (2dp). Only call at the final render/export step. */
export function toDisplay(decimalValue) {
  if (decimalValue === null || decimalValue === undefined) return null;
  return toDecimal(decimalValue)?.toDecimalPlaces(DISPLAY_DP, Decimal.ROUND_HALF_UP) ?? null;
}

/** Format a Decimal (or number/string) as a USD string, e.g. "$1,370.37". Display-only. */
export function formatCurrency(value) {
  const d = toDecimal(value);
  if (d === null) return '—';
  const rounded = d.toDecimalPlaces(DISPLAY_DP, Decimal.ROUND_HALF_UP);
  const [whole, frac] = rounded.toFixed(DISPLAY_DP).split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = rounded.isNegative() ? '-' : '';
  const wholeAbs = withCommas.replace('-', '');
  return `${sign}$${wholeAbs}.${frac}`;
}

/** Format a Decimal (or number/string) as a plain qty string with thousands separators. Display-only. */
export function formatQty(value, decimalPlaces = 2) {
  const d = toDecimal(value);
  if (d === null) return '—';
  const rounded = d.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP);
  const fixed = rounded.toFixed(decimalPlaces);
  const [whole, frac] = fixed.split('.');
  const withCommas = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = rounded.isNegative() ? '-' : '';
  return frac ? `${sign}${withCommas}.${frac}` : `${sign}${withCommas}`;
}

/**
 * Excel date serial -> JS Date.
 * Formula: new Date((serial - 25569) * 86400 * 1000)
 *
 * Example: serial=44927 -> 2023-01-01T00:00:00.000Z
 * Example: serial=46198 -> 2026-06-25T00:00:00.000Z
 * Example: serial=45658 -> 2025-01-01T00:00:00.000Z
 *
 * After conversion the resulting year MUST be within [2020, 2035]. If it
 * falls outside that range the row is flagged invalid and NOT processed —
 * this catches garbage serials (e.g. a stray text value coerced to a tiny
 * or huge number) before it can silently corrupt a claim date.
 */
export function excelSerialToDate(serial) {
  const serialD = toDecimal(serial);
  if (serialD === null) return { date: null, valid: false, reason: 'Serial is missing or non-numeric' };

  // Date math (day/second/millisecond conversion) is calendar arithmetic, not
  // a monetary/quantity calculation, so plain JS arithmetic is used here per
  // the exact formula specified — the Decimal guard above still protects
  // against non-numeric input.
  const serialNum = serialD.toNumber();
  const ms = (serialNum - 25569) * 86400 * 1000;
  const date = new Date(ms);

  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 2020 || year > 2035) {
    return { date: null, valid: false, reason: `Resulting year ${year} is outside the valid range 2020-2035` };
  }
  return { date, valid: true, reason: null };
}

/**
 * Normalizes a raw Excel cell value that represents a date into an ISO
 * "YYYY-MM-DD" string, for columns like exp_day where the source file may
 * store either a real date string or a numeric Excel serial (since the
 * workbook is read without cellDates, date-formatted cells surface as
 * plain numbers). Returns null (never throws) for anything unparseable.
 */
export function normalizeExcelDateCell(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;

  if (rawValue instanceof Date) {
    if (Number.isNaN(rawValue.getTime())) return null;
    return rawValue.toISOString().slice(0, 10);
  }

  if (typeof rawValue === 'number') {
    const { date, valid } = excelSerialToDate(rawValue);
    return valid ? date.toISOString().slice(0, 10) : null;
  }

  const str = String(rawValue).trim();
  if (str === '') return null;

  // Already ISO (YYYY-MM-DD).
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Common US format M/D/YYYY or MM/DD/YYYY.
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, mm, dd, yyyy] = usMatch;
    const year = Number(yyyy);
    if (year < 2020 || year > 2035) return null;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  // A bare numeric string (e.g. an Excel serial exported as text).
  if (/^\d+(\.\d+)?$/.test(str)) {
    const { date, valid } = excelSerialToDate(Number(str));
    return valid ? date.toISOString().slice(0, 10) : null;
  }

  return null;
}

/** Sum an array of raw qty values (from claim rows sharing the same normalized NDC) using decimal.js. */
export function sumQty(values) {
  return values.reduce((acc, v) => {
    const d = toDecimal(v);
    return d === null ? acc : acc.plus(d);
  }, new Decimal(0));
}

export { Decimal };
