import { parsePharmacyPdfGeneric } from './genericPdfHeuristics.js';

/**
 * Lawrence House claim PDF parser.
 * TODO: tune against real Lawrence House sample PDFs (column order, any
 * Rx#/fill-date columns that should be ignored). Falls back to the shared
 * heuristic parser + manual-entry UI until then.
 */
export async function parseLawrenceHousePdf(arrayBuffer) {
  return parsePharmacyPdfGeneric(arrayBuffer, 'Lawrence House');
}
