import { supabase } from './supabaseClient.js';
import { Decimal } from './calculations.js';

/**
 * Fetches claims in a date range, filtered at the DATABASE level by facility
 * and (optionally) a single pharmacy — never client-side filtering after a
 * combined fetch. Joined with pharmacy/facility/uploader names for display.
 */
export async function fetchClaimsHistory({ facilityId, pharmacyId, dateFrom, dateTo }) {
  let query = supabase
    .from('claims')
    .select('*, pharmacies(name), facilities(name), users(email)')
    .order('claim_date', { ascending: false });

  if (facilityId && facilityId !== 'all') query = query.eq('facility_id', facilityId);
  if (pharmacyId && pharmacyId !== 'all') query = query.eq('pharmacy_id', pharmacyId);
  if (dateFrom) query = query.gte('claim_date', dateFrom);
  if (dateTo) query = query.lte('claim_date', dateTo);

  const { data: claims, error } = await query;
  if (error) throw error;

  return (claims ?? []).map((c) => ({
    ...c,
    pharmacyName: c.pharmacies?.name ?? '—',
    facilityName: c.facilities?.name ?? '—',
    uploadedByEmail: c.users?.email ?? '—',
    ndcCount: c.matched_count ?? 0,
    totalQty: new Decimal(c.total_qty_dispensed ?? 0),
    unmatchedCount: c.unmatched_count ?? 0,
  }));
}

/** Dashboard summary cards — all four figures are filtered by facility AND (optionally) pharmacy at the query level. */
export async function fetchDashboardSummary({ facilityId, pharmacyId, month, year }) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  let claimsQuery = supabase
    .from('claims')
    .select('id, total_reimbursement, unmatched_count, facility_id, pharmacy_id')
    .gte('claim_date', monthStart)
    .lt('claim_date', nextMonth);
  if (facilityId && facilityId !== 'all') claimsQuery = claimsQuery.eq('facility_id', facilityId);
  if (pharmacyId && pharmacyId !== 'all') claimsQuery = claimsQuery.eq('pharmacy_id', pharmacyId);
  const { data: claims, error: claimsErr } = await claimsQuery;
  if (claimsErr) throw claimsErr;

  const unmatchedCount = (claims ?? []).reduce((sum, c) => sum + (c.unmatched_count ?? 0), 0);

  const sixtyDaysOut = new Date();
  sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
  let expiringQuery = supabase
    .from('accumulator')
    .select('id', { count: 'exact', head: true })
    .lte('exp_day', sixtyDaysOut.toISOString().slice(0, 10))
    .eq('month', month)
    .eq('year', year);
  if (facilityId && facilityId !== 'all') expiringQuery = expiringQuery.eq('facility_id', facilityId);
  if (pharmacyId && pharmacyId !== 'all') expiringQuery = expiringQuery.eq('pharmacy_id', pharmacyId);
  const { count: expiringCount, error: expErr } = await expiringQuery;
  if (expErr) throw expErr;

  const totalReimbursement = (claims ?? []).reduce((sum, c) => sum.plus(new Decimal(c.total_reimbursement ?? 0)), new Decimal(0));

  return {
    totalReimbursement,
    totalClaims: (claims ?? []).length,
    unmatchedCount,
    expiringCount: expiringCount ?? 0,
  };
}

/** Daily reimbursement trend for the chart — same facility+pharmacy scoping as the summary cards. */
export async function fetchDailyTrend({ facilityId, pharmacyId, month, year }) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  let query = supabase
    .from('claims')
    .select('claim_date, total_reimbursement, facility_id, pharmacy_id')
    .gte('claim_date', monthStart)
    .lt('claim_date', nextMonth);
  if (facilityId && facilityId !== 'all') query = query.eq('facility_id', facilityId);
  if (pharmacyId && pharmacyId !== 'all') query = query.eq('pharmacy_id', pharmacyId);
  const { data, error } = await query;
  if (error) throw error;

  const byDate = new Map();
  for (const row of data ?? []) {
    const day = row.claim_date.slice(8, 10);
    const prior = byDate.get(day) ?? new Decimal(0);
    byDate.set(day, prior.plus(new Decimal(row.total_reimbursement ?? 0)));
  }
  return Array.from(byDate.entries())
    .map(([day, total]) => ({ day, total: Number(total.toDecimalPlaces(2).toFixed(2)) }))
    .sort((a, b) => Number(a.day) - Number(b.day));
}

/** Full claim batch detail: the claim record + every line item (full RX-level ledger). */
export async function fetchClaimDetail(claimId) {
  const { data: claim, error } = await supabase
    .from('claims')
    .select('*, pharmacies(name), facilities(name), users(email)')
    .eq('id', claimId)
    .single();
  if (error) throw error;

  const { data: lineItems, error: liErr } = await supabase
    .from('claim_line_items')
    .select('*')
    .eq('claim_id', claimId)
    .order('ndc');
  if (liErr) throw liErr;

  return { claim, lineItems: lineItems ?? [] };
}

/** Claim batch search — facility/pharmacy scope rules match every other page; filters applied at the query level. */
export async function searchClaimBatches({ facilityId, pharmacyId, dateFrom, dateTo, uploadDateFrom, uploadDateTo, filenameQuery, status }) {
  let query = supabase
    .from('claims')
    .select('*, pharmacies(name), facilities(name), users(email)')
    .order('claim_date', { ascending: false });

  if (facilityId && facilityId !== 'all') query = query.eq('facility_id', facilityId);
  if (pharmacyId && pharmacyId !== 'all') query = query.eq('pharmacy_id', pharmacyId);
  if (dateFrom) query = query.gte('claim_date', dateFrom);
  if (dateTo) query = query.lte('claim_date', dateTo);
  if (uploadDateFrom) query = query.gte('uploaded_at', `${uploadDateFrom}T00:00:00Z`);
  if (uploadDateTo) query = query.lte('uploaded_at', `${uploadDateTo}T23:59:59Z`);
  if (filenameQuery) query = query.ilike('original_filename', `%${filenameQuery}%`);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((c) => ({
    ...c,
    pharmacyName: c.pharmacies?.name ?? '—',
    facilityName: c.facilities?.name ?? '—',
    uploadedByEmail: c.users?.email ?? '—',
  }));
}
