import { supabase } from './supabaseClient.js';
import { Decimal } from './calculations.js';
import { fetchPeriods, fetchAccumulatorRows } from './accumulatorApi.js';

/** All accumulator months on record for a facility, each with its full row set — used for the multi-sheet Accumulator export. */
export async function fetchAllAccumulatorMonths(facilityId) {
  const periods = await fetchPeriods(facilityId);
  const months = [];
  for (const p of periods) {
    const rows = await fetchAccumulatorRows(facilityId, p.month, p.year);
    months.push({ month: p.month, year: p.year, rows });
  }
  return months;
}

/**
 * Monthly Reimbursement Report grouped by pharmacy. Totals are SUMS of each
 * claim line item's already-correct reimbursement_owed/packs_dispensed —
 * never recomputed as totalQty × a single representative PPU, so a mid-month
 * PPU change on the accumulator can't silently distort the total.
 */
export async function fetchMonthlyReimbursementByPharmacy(facilityId, month, year) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const { data: claims, error: claimsErr } = await supabase
    .from('claims')
    .select('id, pharmacy_id, pharmacies(name)')
    .eq('facility_id', facilityId)
    .gte('claim_date', monthStart)
    .lt('claim_date', nextMonth);
  if (claimsErr) throw claimsErr;

  const claimIds = (claims ?? []).map((c) => c.id);
  const pharmacyByClaimId = new Map((claims ?? []).map((c) => [c.id, { id: c.pharmacy_id, name: c.pharmacies?.name ?? 'Unknown' }]));

  if (claimIds.length === 0) return [];

  const { data: lineItems, error: liErr } = await supabase
    .from('claim_line_items')
    .select('claim_id, ndc, product_name, qty_dispensed, packs_dispensed, ppu_340b, reimbursement_owed')
    .in('claim_id', claimIds)
    .eq('matched', true);
  if (liErr) throw liErr;

  // pharmacyId -> ndc -> aggregate
  const pharmacyMap = new Map();
  for (const li of lineItems ?? []) {
    const pharmacy = pharmacyByClaimId.get(li.claim_id);
    if (!pharmacy) continue;
    if (!pharmacyMap.has(pharmacy.id)) pharmacyMap.set(pharmacy.id, { pharmacyName: pharmacy.name, ndcMap: new Map() });
    const { ndcMap } = pharmacyMap.get(pharmacy.id);

    const existing = ndcMap.get(li.ndc);
    const qty = new Decimal(li.qty_dispensed ?? 0);
    const packs = li.packs_dispensed !== null ? new Decimal(li.packs_dispensed) : null;
    const reimb = new Decimal(li.reimbursement_owed ?? 0);

    if (existing) {
      existing.total_qty = existing.total_qty.plus(qty);
      existing.total_packs = packs !== null && existing.total_packs !== null ? existing.total_packs.plus(packs) : existing.total_packs;
      existing.total_reimbursement = existing.total_reimbursement.plus(reimb);
      existing.ppu_340b = li.ppu_340b ?? existing.ppu_340b;
    } else {
      ndcMap.set(li.ndc, {
        ndc: li.ndc,
        product_name: li.product_name,
        total_qty: qty,
        total_packs: packs,
        total_reimbursement: reimb,
        ppu_340b: li.ppu_340b,
      });
    }
  }

  return Array.from(pharmacyMap.values()).map(({ pharmacyName, ndcMap }) => ({
    pharmacyName,
    rows: Array.from(ndcMap.values()),
  }));
}

/** Full accumulator_audit_log rows in a date range, joined with user email for display. */
export async function fetchAuditLog(dateFrom, dateTo) {
  const { data, error } = await supabase
    .from('accumulator_audit_log')
    .select('*, users(email)')
    .gte('timestamp', `${dateFrom}T00:00:00Z`)
    .lte('timestamp', `${dateTo}T23:59:59Z`)
    .order('timestamp', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, userEmail: r.users?.email ?? r.user_id }));
}
