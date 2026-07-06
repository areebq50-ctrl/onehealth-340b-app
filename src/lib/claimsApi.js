import { supabase } from './supabaseClient.js';

/** Checks whether a claim already exists for this pharmacy+facility+date (duplicate upload guard). Scoped by pharmacy — a same-date upload for a different pharmacy is never flagged. */
export async function findExistingClaim(pharmacyId, facilityId, claimDate) {
  const { data, error } = await supabase
    .from('claims')
    .select('id, uploaded_at, total_reimbursement, original_filename, file_hash')
    .eq('pharmacy_id', pharmacyId)
    .eq('facility_id', facilityId)
    .eq('claim_date', claimDate)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** SHA-256 hash of the uploaded file's bytes, used alongside pharmacy+facility+date for duplicate detection. */
export async function computeFileHash(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns true if the accumulator has at least one row for this facility/pharmacy/month/year (i.e. this pharmacy's month has been started). */
export async function accumulatorPeriodExists(facilityId, pharmacyId, month, year) {
  const { count, error } = await supabase
    .from('accumulator')
    .select('id', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
    .eq('pharmacy_id', pharmacyId)
    .eq('month', month)
    .eq('year', year);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Looks up a single accumulator row by normalized NDC + facility + pharmacy + period, used for the "reassign NDC" fix-up flow. */
export async function findAccumulatorRow(facilityId, pharmacyId, month, year, ndc) {
  const { data, error } = await supabase
    .from('accumulator')
    .select('*')
    .eq('facility_id', facilityId)
    .eq('pharmacy_id', pharmacyId)
    .eq('month', month)
    .eq('year', year)
    .eq('ndc', ndc)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Cross-references pivoted claim rows against the accumulator for the
 * claim date's month/year + facility + pharmacy. NDC-to-NDC join only, both
 * sides already normalized to 11-digit strings before this is called. Never
 * matches against another pharmacy's accumulator rows even if the NDC exists there.
 */
export async function matchAgainstAccumulator(facilityId, pharmacyId, month, year, pivotRows) {
  const { data: accumulatorRows, error } = await supabase
    .from('accumulator')
    .select('*')
    .eq('facility_id', facilityId)
    .eq('pharmacy_id', pharmacyId)
    .eq('month', month)
    .eq('year', year);
  if (error) throw error;

  const byNdc = new Map((accumulatorRows ?? []).map((row) => [row.ndc, row]));

  return pivotRows.map((row) => {
    const acc = byNdc.get(row.ndc);
    return { ...row, matched: Boolean(acc), accumulator: acc ?? null };
  });
}

/** Uploads the original claim file to Storage at claim-files/{facility}/{pharmacy}/{date}/{filename}. */
export async function uploadClaimFile(file, { facilityShortCode, pharmacyName, claimDate }) {
  const safePharmacy = pharmacyName.replace(/[^a-z0-9]+/gi, '-');
  const path = `${facilityShortCode}/${safePharmacy}/${claimDate}/${Date.now()}-${file.name}`;
  const { error } = await supabase.storage.from('claim-files').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

/** Short-lived signed URL for previewing/downloading a stored claim file — never exposes a public Storage URL. */
export async function getClaimFileSignedUrl(filePath, expiresInSeconds = 300) {
  const { data, error } = await supabase.storage.from('claim-files').createSignedUrl(filePath, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Calls the process_claim RPC — a single atomic Postgres transaction that
 * writes the claim, line items (full RX-level ledger), accumulator updates
 * scoped to this exact pharmacy, and audit log rows.
 * lineItems: [{ ndc, qty_dispensed, matched, product_name_raw, refill_no, rx_number, ... }]
 */
export async function processClaim({
  pharmacyId,
  facilityId,
  claimDate,
  filePath,
  lineItems,
  rawLines,
  overwrite,
  originalFilename,
  fileHash,
  totalRows,
  validRows,
  invalidRows,
}) {
  const { data, error } = await supabase.rpc('process_claim', {
    p_pharmacy_id: pharmacyId,
    p_facility_id: facilityId,
    p_claim_date: claimDate,
    p_file_path: filePath,
    p_line_items: lineItems,
    p_raw_lines: rawLines ?? null,
    p_overwrite: overwrite,
    p_original_filename: originalFilename ?? null,
    p_file_hash: fileHash ?? null,
    p_total_rows: totalRows ?? null,
    p_valid_rows: validRows ?? null,
    p_invalid_rows: invalidRows ?? null,
  });
  if (error) throw error;
  return data; // claim id (== claim batch id)
}

/** Full per-RX raw ledger for a claim batch — the "All Claims" tab data source. */
export async function fetchClaimRawLines(claimId) {
  const { data, error } = await supabase.from('claim_raw_lines').select('*').eq('claim_id', claimId).order('line_number');
  if (error) throw error;
  return data ?? [];
}

/** Every accumulator_audit_log entry produced by a specific claim batch — the "Audit History" / "Accumulator Changes" tab. */
export async function fetchAuditLogByClaim(claimId) {
  const { data, error } = await supabase
    .from('accumulator_audit_log')
    .select('*, users(email)')
    .eq('claim_id', claimId)
    .order('timestamp');
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, userEmail: r.users?.email ?? r.user_id }));
}

/**
 * Deletes an entire claim batch (admin-only, latest-period-only). Reverses
 * its accumulator effect for every matched NDC first (adds dispensed qty
 * back, logs a claim_reversal audit row), then deletes the claim and its
 * line items/raw lines. The claim's original claim_dispense audit rows are
 * never removed — the audit trail is immutable even after the claim itself
 * is gone.
 */
export async function deleteClaim(claimId) {
  const { error } = await supabase.rpc('delete_claim', { p_claim_id: claimId });
  if (error) throw error;
}
