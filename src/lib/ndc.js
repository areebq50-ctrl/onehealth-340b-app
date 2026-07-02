/**
 * NDC (National Drug Code) normalization.
 *
 * Rule (per project spec): strip all dashes/spaces from the raw NDC, then
 * left-pad the remaining digit string with zeros to 11 characters.
 *
 * Example:  "54032656"     -> "00054032656"
 * Example:  "0069-3150-83" -> "0069315083" (10 digits) -> "00069315083"
 * Example:  "50242-091-01" -> "5024209101" (10 digits) -> "05024209101"
 * Example:  "12345678901"  -> "12345678901" (already 11 digits, unchanged)
 * Example:  "0002-1433-80" -> "0002143380" (10 digits) -> "00002143380"
 *
 * This normalization MUST be applied to both sides of every claim-to-accumulator
 * join before comparing. Never join on drug name.
 *
 * Returns null (not an exception) for values that cannot be normalized, so
 * callers can route the row to a "skipped/invalid" bucket instead of crashing.
 */
export function normalizeNdc(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;

  const asString = String(rawValue).trim();
  if (asString === '') return null;

  const rejectPhrases = ['grand total', 'blank', '#n/a', 'n/a', 'total'];
  if (rejectPhrases.includes(asString.toLowerCase())) return null;

  // Strip everything except digits (dashes, spaces, and any stray formatting).
  const digitsOnly = asString.replace(/\D/g, '');
  if (digitsOnly === '') return null;

  // Excel sometimes stores NDCs as floats and appends a trailing ".0" — the
  // \D strip above already removes the "." so this is just a length guard.
  if (digitsOnly.length > 11) return null; // cannot be a valid NDC-11, flag as invalid

  return digitsOnly.padStart(11, '0');
}

/**
 * True if the raw value is a well-formed NDC-normalizable string.
 */
export function isValidNdc(rawValue) {
  return normalizeNdc(rawValue) !== null;
}
