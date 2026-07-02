import { parseLawrenceHausePdf } from './lawrenceHause.js';
import { parseBlueSwanPdf } from './blueSwan.js';
import { parseThirdCoastPdf } from './thirdCoast.js';
import { parsePharmacyPdfGeneric } from './genericPdfHeuristics.js';

/** Maps a pharmacy name (as stored in public.pharmacies.name) to its PDF parser module. */
const PHARMACY_PDF_PARSERS = {
  'Lawrence Hause': parseLawrenceHausePdf,
  'Blue Swan': parseBlueSwanPdf,
  'Third Coast': parseThirdCoastPdf,
};

/** Falls back to the generic heuristic parser for any pharmacy without a dedicated module. */
export function getPdfParserForPharmacy(pharmacyName) {
  return PHARMACY_PDF_PARSERS[pharmacyName] ?? ((buf) => parsePharmacyPdfGeneric(buf, pharmacyName ?? 'Unknown pharmacy'));
}

export { parseClaimsXlsx } from './xlsxParser.js';
