/**
 * openFDA NDC Directory lookup, used to pre-fill the "add unmatched NDC"
 * review form. Free, no API key required: https://api.fda.gov/drug/ndc.json
 *
 * IMPORTANT LIMITATION: openFDA's NDC Directory has no concept of the 340B
 * program — it can never supply 340B Price, 340B PPU, or CIN (those are
 * proprietary pricing/contract data). This module only ever returns
 * Product Name, Manufacturer, and a best-effort Pack Size suggestion parsed
 * from the packaging description. Every field this returns is a suggestion
 * for the user to review, correct, and confirm — never auto-submitted.
 *
 * openFDA's own `product_ndc`/`package_ndc` fields use dashed segments
 * (labeler-product-package), whose exact digit-group widths (4-4-2, 5-3-2,
 * or 5-4-1) can't be recovered with certainty from a flat zero-padded
 * 11-digit string alone. We try the standard reconstructions in order and
 * use whichever one gets a hit; if none do, we fall back to a bare
 * product_ndc (labeler-product only, no package segment) search. If every
 * attempt comes back empty, we report not-found rather than guessing.
 */

const OPENFDA_BASE = 'https://api.fda.gov/drug/ndc.json';

/**
 * Given an 11-digit zero-padded NDC string, produce the plausible dashed
 * package_ndc candidates (5-4-2 direct read, plus the 4-4-2 / 5-3-2 / 5-4-1
 * re-groupings that a plain left-pad can obscure) and a bare product_ndc
 * (labeler-product, no package segment) fallback candidate.
 */
export function buildNdcSearchCandidates(ndc11) {
  if (typeof ndc11 !== 'string' || !/^\d{11}$/.test(ndc11)) return { packageCandidates: [], productCandidates: [] };

  const packageCandidates = new Set();
  const productCandidates = new Set();

  // Direct 5-4-2 read (the "no re-grouping needed" case).
  packageCandidates.add(`${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}-${ndc11.slice(9, 11)}`);
  productCandidates.add(`${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}`);

  // 4-4-2 original (labeler was 4 digits, left-pad added a leading zero).
  if (ndc11[0] === '0') {
    packageCandidates.add(`${ndc11.slice(1, 5)}-${ndc11.slice(5, 9)}-${ndc11.slice(9, 11)}`);
    productCandidates.add(`${ndc11.slice(1, 5)}-${ndc11.slice(5, 9)}`);
  }

  // 5-3-2 original (product segment was 3 digits, zero-padded to 4 in the middle).
  if (ndc11[5] === '0') {
    packageCandidates.add(`${ndc11.slice(0, 5)}-${ndc11.slice(6, 9)}-${ndc11.slice(9, 11)}`);
    productCandidates.add(`${ndc11.slice(0, 5)}-${ndc11.slice(6, 9)}`);
  }

  // 5-4-1 original (package segment was 1 digit, zero-padded to 2 at the end).
  if (ndc11[9] === '0') {
    packageCandidates.add(`${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}-${ndc11.slice(10, 11)}`);
  }

  return { packageCandidates: Array.from(packageCandidates), productCandidates: Array.from(productCandidates) };
}

/** Best-effort parse of a pack size from an openFDA packaging description, e.g. "30 TABLET in 1 BOTTLE". */
function parsePackSizeFromDescription(description) {
  if (!description) return null;
  const match = description.match(/^\s*(\d+(?:\.\d+)?)\s/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function mapResult(result, matchedPackageNdc) {
  const packaging = (result.packaging ?? []).find((p) => p.package_ndc === matchedPackageNdc) ?? result.packaging?.[0] ?? null;
  return {
    found: true,
    productName: result.brand_name || result.generic_name || null,
    manufacturer: result.labeler_name || null,
    packSizeSuggestion: parsePackSizeFromDescription(packaging?.description),
    dosageForm: result.dosage_form || null,
    route: Array.isArray(result.route) ? result.route.join(', ') : result.route || null,
    packagingDescription: packaging?.description || null,
    productNdc: result.product_ndc || null,
    source: 'openFDA',
    // 340B pricing fields are never available from openFDA — always null,
    // always left for manual entry.
    price340b: null,
    ppu340b: null,
    cin: null,
  };
}

async function queryOpenFda(field, value) {
  const url = `${OPENFDA_BASE}?search=${encodeURIComponent(`${field}:"${value}"`)}&limit=1`;
  const res = await fetch(url);
  if (res.status === 404) return null; // openFDA returns 404 for "no matches", not an error
  if (!res.ok) throw new Error(`openFDA request failed: HTTP ${res.status}`);
  const body = await res.json();
  return body.results?.[0] ?? null;
}

/**
 * Looks up a normalized 11-digit NDC against the openFDA NDC Directory.
 * Never throws for "not found" — returns { found: false }. Throws only on
 * an actual network/API failure so the caller can distinguish "nothing on
 * file" from "the lookup itself broke".
 */
export async function lookupNdcFromFda(ndc11) {
  const { packageCandidates, productCandidates } = buildNdcSearchCandidates(ndc11);

  for (const candidate of packageCandidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await queryOpenFda('packaging.package_ndc', candidate);
    if (result) return mapResult(result, candidate);
  }

  for (const candidate of productCandidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await queryOpenFda('product_ndc', candidate);
    if (result) return mapResult(result, null);
  }

  return { found: false };
}
