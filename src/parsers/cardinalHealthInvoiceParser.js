import { extractPdfPositionedTextRows } from './pdfParserBase.js';
import { normalizeNdc } from '../lib/ndc.js';

/**
 * Column x-position boundaries for a Cardinal Health wholesaler invoice
 * ("invoiceReprint" layout: LINE | ITEM | NDC/UPC | ORIG ORDER QTY | ORDER
 * QTY | INVOICED QTY | OMIT CODE | UOM | DESCRIPTION | SIZE | FORM | CLASS
 * | MSG | DEPT/ACC/CC2 | UNIT PRICE | EXTENDED PRICE | NOTE CODE).
 *
 * Verified against a real sample invoice's actual pdfjs text-item x
 * coordinates (not guessed from token order) — every column boundary below
 * is the midpoint between two adjacent columns' observed positions, so
 * numeric fragments always land in the correct bucket even when a column is
 * blank for a given row (e.g. OMIT CODE/CLASS/MSG are frequently empty).
 */
const COLUMN_BOUNDARIES = [
  { key: 'line', max: 35 },
  { key: 'item', max: 70 },
  { key: 'ndc', max: 145 },
  { key: 'origOrderQty', max: 190 },
  { key: 'orderQty', max: 225 },
  { key: 'invoicedQty', max: 250 },
  { key: 'omitCode', max: 262 },
  { key: 'uom', max: 280 },
  { key: 'description', max: 430 },
  { key: 'size', max: 452 },
  { key: 'form', max: 470 },
  { key: 'class', max: 495 },
  { key: 'msg', max: 555 },
  { key: 'dept', max: 640 },
  { key: 'unitPrice', max: 715 },
  { key: 'extendedPrice', max: 765 },
];

function bucketFor(x) {
  for (const b of COLUMN_BOUNDARIES) {
    if (x < b.max) return b.key;
  }
  return 'noteCode';
}

function parseMoney(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Best-effort leading-number extraction from a SIZE cell, e.g. "8.5 GM" ->
 * 8.5, "30 EA" -> 30, "1000" -> 1000.
 *
 * Deliberately returns null (never a guess) for a compound "NxM" size like
 * "3X28E" (3 blister packs of 28 units each) — silently taking the leading
 * "3" would compute a quantity ~28x too low. There is no way to know which
 * factor (or their product) matches this pharmacy's own accumulator
 * convention for that NDC without the pharmacy confirming it, so these rows
 * are flagged invalidSize and must be reviewed/entered manually.
 */
function parseSizeNumeric(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+\s*[xX]\s*\d+/.test(trimmed)) return null;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parses a Cardinal Health invoice PDF into per-line-item rows. Never
 * throws for a single bad row — each row is independently flagged
 * (invalidNdc / invalidSize) so the receiving UI can show exactly which
 * lines need manual review instead of silently computing a wrong
 * quantity-received or skipping a line without saying why.
 */
export async function parseCardinalHealthInvoice(arrayBuffer) {
  let pageRows;
  try {
    pageRows = await extractPdfPositionedTextRows(arrayBuffer);
  } catch (err) {
    return { rows: [], error: `Could not read PDF: ${err.message}` };
  }

  const allRows = pageRows.flatMap((p) => p.rows);
  if (allRows.length === 0) {
    return { rows: [], error: 'PDF contains no extractable text. It may be a scanned image.' };
  }

  const rows = [];
  for (const rowItems of allRows) {
    const cols = {};
    for (const item of rowItems) {
      const key = bucketFor(item.x);
      cols[key] = cols[key] ? `${cols[key]} ${item.text}` : item.text;
    }

    // A real item line always has a pure-integer LINE number and an
    // NDC/UPC fragment — this is what distinguishes item rows from the
    // header, TOTE/DLVRY grouping rows, and page-footer text.
    const lineNo = cols.line?.trim();
    if (!lineNo || !/^\d+$/.test(lineNo) || !cols.ndc) continue;

    const ndcRaw = cols.ndc.trim();
    const ndc = normalizeNdc(ndcRaw);
    const sizeRaw = cols.size?.trim() ?? null;
    const sizeNumeric = parseSizeNumeric(sizeRaw);
    const invoicedQty = cols.invoicedQty ? Number(cols.invoicedQty.trim()) : null;

    rows.push({
      lineNo,
      ndcRaw,
      ndc,
      description: cols.description?.trim() ?? '',
      sizeRaw,
      sizeNumeric,
      form: cols.form?.trim() ?? null,
      invoicedQty: Number.isFinite(invoicedQty) ? invoicedQty : null,
      unitPrice: parseMoney(cols.unitPrice),
      extendedPrice: parseMoney(cols.extendedPrice),
      invalidNdc: ndc === null,
      invalidSize: sizeNumeric === null,
      backordered: invoicedQty === 0,
    });
  }

  if (rows.length === 0) {
    return {
      rows: [],
      error: 'Could not find any invoice line items in this PDF. This parser expects the Cardinal Health "invoiceReprint" layout — use manual entry if this is a different wholesaler format.',
    };
  }

  return { rows, error: null };
}
