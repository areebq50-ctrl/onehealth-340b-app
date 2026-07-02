import { parsePharmacyPdfGeneric } from './genericPdfHeuristics.js';

/**
 * Third Coast claim PDF parser.
 * TODO: tune against real Third Coast sample PDFs (column order, any
 * Rx#/fill-date columns that should be ignored). Falls back to the shared
 * heuristic parser + manual-entry UI until then.
 */
export async function parseThirdCoastPdf(arrayBuffer) {
  return parsePharmacyPdfGeneric(arrayBuffer, 'Third Coast');
}
