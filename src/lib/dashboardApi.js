import { supabase } from './supabaseClient.js';
import { Decimal } from './calculations.js';

/**
 * Fetches claims in a date range (optionally filtered by facility/pharmacy),
 * joined with pharmacy/facility/uploader names for display, plus per-claim
 * line-item aggregates (NDC count, total qty) computed from claim_line_items
 * since claims itself only stores total_reimbursement.
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

  const claimIds = (claims ?? []).map((c) => c.id);
  let lineItems = [];
  if (claimIds.length > 0) {
    const { data, error: liErr } = await supabase
      .from('claim_line_items')
      .select('claim_id, ndc, qty_dispensed, matched')
      .in('claim_id', claimIds);
    if (liErr) throw liErr;
    lineItems = data ?? [];
  }

  const aggByClaimId = new Map();
  for (const li of lineItems) {
    const agg = aggByClaimId.get(li.claim_id) ?? { ndcCount: 0, totalQty: new Decimal(0), unmatchedCount: 0 };
    if (li.matched) {
      agg.ndcCount += 1;
      agg.totalQty = agg.totalQty.plus(new Decimal(li.qty_dispensed ?? 0));
    } else {
      agg.unmatchedCount += 1;
    }
    aggByClaimId.set(li.claim_id, agg);
  }

  return (claims ?? []).map((c) => ({
    ...c,
    pharmacyName: c.pharmacies?.name ?? '—',
    facilityName: c.facilities?.name ?? '—',
    uploadedByEmail: c.users?.email ?? '—',
    ndcCount: aggByClaimId.get(c.id)?.ndcCount ?? 0,
    totalQty: aggByClaimId.get(c.id)?.totalQty ?? new Decimal(0),
    unmatchedCount: aggByClaimId.get(c.id)?.unmatchedCount ?? 0,
  }));
}

export async function fetchDashboardSummary({ facilityId, month, year }) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  let claimsQuery = supabase
    .from('claims')
    .select('id, total_reimbursement, facility_id')
    .gte('claim_date', monthStart)
    .lt('claim_date', nextMonth);
  if (facilityId && facilityId !== 'all') claimsQuery = claimsQuery.eq('facility_id', facilityId);
  const { data: claims, error: claimsErr } = await claimsQuery;
  if (claimsErr) throw claimsErr;

  const claimIds = (claims ?? []).map((c) => c.id);
  let unmatchedCount = 0;
  if (claimIds.length > 0) {
    const { count, error: unmatchedErr } = await supabase
      .from('claim_line_items')
      .select('id', { count: 'exact', head: true })
      .in('claim_id', claimIds)
      .eq('matched', false);
    if (unmatchedErr) throw unmatchedErr;
    unmatchedCount = count ?? 0;
  }

  const sixtyDaysOut = new Date();
  sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
  let expiringQuery = supabase
    .from('accumulator')
    .select('id', { count: 'exact', head: true })
    .lte('exp_day', sixtyDaysOut.toISOString().slice(0, 10))
    .eq('month', month)
    .eq('year', year);
  if (facilityId && facilityId !== 'all') expiringQuery = expiringQuery.eq('facility_id', facilityId);
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

export async function fetchDailyTrend({ facilityId, month, year }) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  let query = supabase
    .from('claims')
    .select('claim_date, total_reimbursement, facility_id')
    .gte('claim_date', monthStart)
    .lt('claim_date', nextMonth);
  if (facilityId && facilityId !== 'all') query = query.eq('facility_id', facilityId);
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
