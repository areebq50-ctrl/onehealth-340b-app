import { supabase } from './supabaseClient.js';

/** Checks whether a claim already exists for this pharmacy+facility+date (duplicate upload guard). */
export async function findExistingClaim(pharmacyId, facilityId, claimDate) {
  const { data, error } = await supabase
    .from('claims')
    .select('id, uploaded_at, total_reimbursement')
    .eq('pharmacy_id', pharmacyId)
    .eq('facility_id', facilityId)
    .eq('claim_date', claimDate)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Returns true if the accumulator has at least one row for this facility/month/year (i.e. the month has been started). */
export async function accumulatorPeriodExists(facilityId, month, year) {
  const { count, error } = await supabase
    .from('accumulator')
    .select('id', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
    .eq('month', month)
    .eq('year', year);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Looks up a single accumulator row by normalized NDC + facility + period, used for the "reassign NDC" fix-up flow. */
export async function findAccumulatorRow(facilityId, month, year, ndc) {
  const { data, error } = await supabase
    .from('accumulator')
    .select('*')
    .eq('facility_id', facilityId)
    .eq('month', month)
    .eq('year', year)
    .eq('ndc', ndc)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Cross-references pivoted claim rows against the accumulator for the
 * claim date's month/year + facility. NDC-to-NDC join only, both sides
 * already normalized to 11-digit strings before this is called.
 */
export async function matchAgainstAccumulator(facilityId, month, year, pivotRows) {
  const { data: accumulatorRows, error } = await supabase
    .from('accumulator')
    .select('*')
    .eq('facility_id', facilityId)
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

/**
 * Calls the process_claim RPC — a single atomic Postgres transaction that
 * writes the claim, line items, accumulator updates, and audit log rows.
 * lineItems: [{ ndc, qty_dispensed, matched, product_name_raw }]
 */
export async function processClaim({ pharmacyId, facilityId, claimDate, filePath, lineItems, overwrite }) {
  const { data, error } = await supabase.rpc('process_claim', {
    p_pharmacy_id: pharmacyId,
    p_facility_id: facilityId,
    p_claim_date: claimDate,
    p_file_path: filePath,
    p_line_items: lineItems,
    p_overwrite: overwrite,
  });
  if (error) throw error;
  return data; // claim id
}
