import { parsePharmacyPdfGeneric } from './genericPdfHeuristics.js';

/**
 * Lawrence Hause claim PDF parser.
 * TODO: tune against real Lawrence Hause sample PDFs (column order, any
 * Rx#/fill-date columns that should be ignored). Falls back to the shared
 * heuristic parser + manual-entry UI until then.
 */
export async function parseLawrenceHausePdf(arrayBuffer) {
  return parsePharmacyPdfGeneric(arrayBuffer, 'Lawrence Hause');
}
