import { extractPdfTextRows, pdfParseResult } from './pdfParserBase.js';

const NDC_PATTERN = /^\d{4,5}-\d{3,4}-\d{1,2}$/;
const NDC_RAW_PATTERN = /^\d{10,11}$/;
const NUMERIC_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Best-effort row parser shared by all pharmacy-specific PDF modules.
 * Each pharmacy's PDF layout differs (column order, spacing, extra columns
 * like Rx# or fill date) so pharmacy modules pass small tuning knobs;
 * the core strategy is the same: within each visually-clustered row of text
 * fragments, find the fragment that looks like an NDC, find a plausible
 * trailing numeric fragment for Qty, and treat everything else as the drug
 * name.
 *
 * IMPORTANT: this heuristic has not been tuned against real sample PDFs from
 * each pharmacy. It is intentionally conservative — when confidence is low
 * it still returns whatever rows it found AND sets needsManualEntry so the
 * upload UI shows the manual-entry fallback table for the user to correct
 * before anything is saved. It never silently produces wrong data.
 */
function parseRow(fragments) {
  const ndcIdx = fragments.findIndex((f) => {
    const t = f.trim();
    return NDC_PATTERN.test(t) || NDC_RAW_PATTERN.test(t);
  });
  if (ndcIdx === -1) return null;

  let qtyIdx = -1;
  for (let i = fragments.length - 1; i >= 0; i--) {
    if (i === ndcIdx) continue;
    if (NUMERIC_PATTERN.test(fragments[i].trim())) {
      qtyIdx = i;
      break;
    }
  }
  if (qtyIdx === -1) return null;

  const drugName = fragments
    .filter((_, i) => i !== ndcIdx && i !== qtyIdx)
    .join(' ')
    .trim();

  return {
    ndcRaw: fragments[ndcIdx].trim(),
    qtyRaw: fragments[qtyIdx].trim(),
    drugName: drugName || '(unnamed)',
  };
}

export async function parsePharmacyPdfGeneric(arrayBuffer, pharmacyLabel) {
  let pageRows;
  try {
    pageRows = await extractPdfTextRows(arrayBuffer);
  } catch (err) {
    return pdfParseResult({
      rows: [],
      error: `Could not read PDF (${pharmacyLabel}): ${err.message}`,
      needsManualEntry: true,
    });
  }

  const allRows = pageRows.flatMap((p) => p.rows);
  if (allRows.length === 0) {
    return pdfParseResult({
      rows: [],
      error: `PDF contains no extractable text (${pharmacyLabel}). It may be a scanned image — use manual entry.`,
      needsManualEntry: true,
    });
  }

  const parsed = allRows.map(parseRow).filter(Boolean);

  if (parsed.length === 0) {
    return pdfParseResult({
      rows: [],
      warning: `Could not automatically extract claim rows from this ${pharmacyLabel} PDF. Please use manual entry to key in the claims.`,
      needsManualEntry: true,
    });
  }

  const matchRate = parsed.length / allRows.length;
  const needsManualEntry = matchRate < 0.3;

  return pdfParseResult({
    rows: parsed,
    warning: needsManualEntry
      ? `Only ${parsed.length} of ${allRows.length} lines on this ${pharmacyLabel} PDF matched the expected layout. Please review the extracted rows carefully or switch to manual entry.`
      : null,
    needsManualEntry,
  });
}
