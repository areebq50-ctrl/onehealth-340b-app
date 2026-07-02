import { parsePharmacyPdfGeneric } from './genericPdfHeuristics.js';

/**
 * Blue Swan claim PDF parser.
 * TODO: tune against real Blue Swan sample PDFs (column order, any
 * Rx#/fill-date columns that should be ignored). Falls back to the shared
 * heuristic parser + manual-entry UI until then.
 */
export async function parseBlueSwanPdf(arrayBuffer) {
  return parsePharmacyPdfGeneric(arrayBuffer, 'Blue Swan');
}
