import { supabase } from './supabaseClient.js';

/**
 * Global "find this drug" search across every facility/pharmacy/period the
 * current user can see (RLS-scoped), matching NDC or product name. Used by
 * the header search box to jump straight to a drug instead of manually
 * reselecting facility -> pharmacy -> period -> scrolling. Only the most
 * recent (month, year) row per facility+pharmacy+NDC combo is kept, so a
 * drug that exists across many historical periods shows up once.
 */
export async function searchAccumulatorGlobal(query) {
  const q = query.trim().replace(/[,()%]/g, '');
  if (!q) return [];
  const { data, error } = await supabase
    .from('accumulator')
    .select('id, ndc, product_name, qty_on_hand, month, year, facility_id, pharmacy_id, facilities(name), pharmacies(name)')
    .or(`ndc.ilike.%${q}%,product_name.ilike.%${q}%`)
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .limit(100);
  if (error) throw error;

  const seen = new Set();
  const results = [];
  for (const r of data ?? []) {
    const key = `${r.facility_id}-${r.pharmacy_id}-${r.ndc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...r, facilityName: r.facilities?.name ?? '—', pharmacyName: r.pharmacies?.name ?? '—' });
    if (results.length >= 10) break;
  }
  return results;
}

/** Distinct (month, year) periods on record for a facility+pharmacy, newest first. */
export async function fetchPeriods(facilityId, pharmacyId) {
  let query = supabase.from('accumulator').select('month, year').eq('facility_id', facilityId);
  query = pharmacyId && pharmacyId !== 'all' ? query.eq('pharmacy_id', pharmacyId) : query;
  const { data, error } = await query;
  if (error) throw error;
  const seen = new Set();
  const periods = [];
  for (const row of data ?? []) {
    const key = `${row.year}-${row.month}`;
    if (!seen.has(key)) {
      seen.add(key);
      periods.push({ month: row.month, year: row.year });
    }
  }
  periods.sort((a, b) => (b.year - a.year) || (b.month - a.month));
  return periods;
}

/** Fetches accumulator rows for a facility+period, optionally scoped to one pharmacy. pharmacyId='all' returns every pharmacy's rows (read-only view), each still tagged with its own pharmacy. */
export async function fetchAccumulatorRows(facilityId, pharmacyId, month, year) {
  let query = supabase
    .from('accumulator')
    .select('*, pharmacies(name)')
    .eq('facility_id', facilityId)
    .eq('month', month)
    .eq('year', year);
  if (pharmacyId && pharmacyId !== 'all') query = query.eq('pharmacy_id', pharmacyId);
  query = query.order('product_name');
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, pharmacyName: r.pharmacies?.name ?? '—' }));
}

export async function editAccumulatorRow(row) {
  // Numeric fields come from plain text inputs, which use '' (not null) to
  // represent "empty" — passing '' straight through to a `numeric` RPC
  // parameter fails in Postgres ("invalid input syntax for type numeric:
  // \"\""), so blank strings are normalized to null here at the one choke
  // point every edit goes through.
  const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : v);
  const { error } = await supabase.rpc('edit_accumulator_row', {
    p_id: row.id,
    p_product_name: row.product_name,
    p_pack_size: numOrNull(row.pack_size),
    p_price_340b: numOrNull(row.price_340b),
    p_ppu_340b: numOrNull(row.ppu_340b),
    p_exp_day: row.exp_day || null,
    p_qty_on_hand: numOrNull(row.qty_on_hand),
    p_cin: row.cin,
    p_manufacturer: row.manufacturer,
  });
  if (error) throw error;
}

export async function deleteAccumulatorRow(id) {
  const { error } = await supabase.rpc('delete_accumulator_row', { p_id: id });
  if (error) throw error;
}

/** Bulk-deletes every accumulator row for one facility+pharmacy+period at once (admin-only, latest period only). Returns the number of rows deleted. */
export async function deleteAccumulatorPeriod({ facilityId, pharmacyId, month, year }) {
  const { data, error } = await supabase.rpc('delete_accumulator_period', {
    p_facility_id: facilityId,
    p_pharmacy_id: pharmacyId,
    p_month: month,
    p_year: year,
  });
  if (error) throw error;
  return data;
}

/**
 * Full reset of one facility+pharmacy+period: deletes every claim for the
 * period (each properly reversed out of the accumulator first, same as
 * deleting them one at a time), THEN deletes the accumulator rows for the
 * period — always in the correct order, atomically, so the period ends up
 * genuinely blank instead of a re-import silently landing on top of stale
 * claim math. Admin-only, latest period only.
 */
export async function resetPeriodData({ facilityId, pharmacyId, month, year }) {
  const { error } = await supabase.rpc('reset_period_data', {
    p_facility_id: facilityId,
    p_pharmacy_id: pharmacyId,
    p_month: month,
    p_year: year,
  });
  if (error) throw error;
}

/** Count of claims already processed for a facility+pharmacy+period — used to warn before a bulk accumulator-period delete. */
export async function countClaimsForPeriod(facilityId, pharmacyId, month, year) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const toDate = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(toDate).padStart(2, '0')}`;
  const { count, error } = await supabase
    .from('claims')
    .select('id', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
    .eq('pharmacy_id', pharmacyId)
    .gte('claim_date', from)
    .lte('claim_date', to);
  if (error) throw error;
  return count ?? 0;
}

/** Count of accumulator rows on record for a facility+pharmacy+period — paired with countClaimsForPeriod to preview a reset before running it. */
export async function countAccumulatorRowsForPeriod(facilityId, pharmacyId, month, year) {
  const { count, error } = await supabase
    .from('accumulator')
    .select('id', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
    .eq('pharmacy_id', pharmacyId)
    .eq('month', month)
    .eq('year', year);
  if (error) throw error;
  return count ?? 0;
}

export async function addAccumulatorRow({ facilityId, pharmacyId, month, year, ndc, productName, packSize, qtyOnHand, expDay, price340b, ppu340b, cin, manufacturer }) {
  const { data, error } = await supabase.rpc('add_accumulator_row', {
    p_facility_id: facilityId,
    p_pharmacy_id: pharmacyId,
    p_month: month,
    p_year: year,
    p_ndc: ndc,
    p_product_name: productName,
    p_pack_size: packSize,
    p_qty_on_hand: qtyOnHand,
    p_exp_day: expDay || null,
    p_price_340b: price340b,
    p_ppu_340b: ppu340b,
    p_cin: cin,
    p_manufacturer: manufacturer,
  });
  if (error) throw error;
  return data;
}

export async function rolloverMonth({ facilityId, pharmacyId, fromMonth, fromYear, toMonth, toYear }) {
  const { data, error } = await supabase.rpc('rollover_month', {
    p_facility_id: facilityId,
    p_pharmacy_id: pharmacyId,
    p_from_month: fromMonth,
    p_from_year: fromYear,
    p_to_month: toMonth,
    p_to_year: toYear,
  });
  if (error) throw error;
  return data;
}

/**
 * Resolves an unmatched claim line item — never a silent drop. Two actions:
 *  - 'add_and_match': creates a new accumulator row (or reuses one already
 *    added by this same call for another line, e.g. re-processed batch) from
 *    the reviewed/confirmed NDC details, then retroactively matches and
 *    deducts this specific claim line against it.
 *  - 'skip': records a mandatory reason; the line stays unmatched but is now
 *    visibly "reviewed and skipped" instead of just "unmatched".
 */
export async function resolveUnmatchedLine({
  lineItemId,
  action,
  ndc,
  productName,
  packSize,
  qtyOnHand,
  expDay,
  price340b,
  ppu340b,
  cin,
  manufacturer,
  skipReason,
}) {
  const { error } = await supabase.rpc('resolve_unmatched_line', {
    p_line_item_id: lineItemId,
    p_action: action,
    p_ndc: ndc ?? null,
    p_product_name: productName ?? null,
    p_pack_size: packSize ?? null,
    p_qty_on_hand: qtyOnHand ?? null,
    p_exp_day: expDay || null,
    p_price_340b: price340b ?? null,
    p_ppu_340b: ppu340b ?? null,
    p_cin: cin ?? null,
    p_manufacturer: manufacturer ?? null,
    p_skip_reason: skipReason ?? null,
  });
  if (error) throw error;
}

/** Marks a replenishment order as placed/received: adds qtyOrdered back into the running balance and logs it. */
export async function confirmReplenishmentOrder({ accumulatorId, qtyOrdered, notes }) {
  const { data, error } = await supabase.rpc('confirm_replenishment_order', {
    p_accumulator_id: accumulatorId,
    p_qty_ordered: qtyOrdered,
    p_notes: notes ?? null,
  });
  if (error) throw error;
  return data;
}

/**
 * Bulk-applies an already-parsed, already-matched wholesaler invoice: each
 * line is {accumulatorId, orderQty, unitCost}. "Order" = Pack Size x
 * Invoiced Qty, matching the pharmacy team's own terminology (their
 * accumulator sheet's "Order"/"Order confirmed" column) — distinct from
 * "New Balance", which is Current Balance + Order, computed server-side.
 * orderQty must already be computed via decimal.js by the caller; this
 * function does no arithmetic of its own, it only threads the pre-computed
 * numbers through to the RPC. Applied atomically; any failing line (e.g. a
 * closed historical period) rolls back the whole batch.
 */
export async function receiveInvoiceBulk({ facilityId, pharmacyId, lines, invoiceNumber, notes }) {
  const { data, error } = await supabase.rpc('receive_invoice_bulk', {
    p_facility_id: facilityId,
    p_pharmacy_id: pharmacyId,
    p_lines: lines.map((l) => ({
      accumulator_id: l.accumulatorId,
      qty_ordered: l.orderQty,
      unit_cost: l.unitCost ?? null,
    })),
    p_invoice_number: invoiceNumber ?? null,
    p_notes: notes ?? null,
  });
  if (error) throw error;
  return data;
}

export async function importAccumulatorRows({ facilityId, pharmacyId, month, year, rows }) {
  const { data, error } = await supabase.rpc('import_accumulator_rows', {
    p_facility_id: facilityId,
    p_pharmacy_id: pharmacyId,
    p_month: month,
    p_year: year,
    p_rows: rows,
  });
  if (error) throw error;
  return data;
}

/**
 * Every accumulator_audit_log entry for one NDC across a whole period —
 * the running, day-by-day ledger view (matching a spreadsheet's "one
 * updated sheet per revision through the month" pattern) as opposed to
 * fetchAuditLogByClaim's single-claim slice. Pulled straight from the
 * insert-only audit trail, so it's the true chronological record, not a
 * reconstruction.
 */
/**
 * Every accumulator_audit_log entry for a facility+pharmacy+period, across
 * ALL NDCs at once — powers the "Daily Ledger" view (the whole accumulator,
 * one row per NDC, as of a chosen day) so it doesn't require opening each
 * NDC's history individually. Grouped/sliced by day per-NDC client-side via
 * lib/ledger.js's buildDailySnapshot.
 */
export async function fetchPeriodAuditHistory(facilityId, pharmacyId, month, year) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const toDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const { data, error } = await supabase
    .from('accumulator_audit_log')
    .select('*')
    .eq('facility_id', facilityId)
    .eq('pharmacy_id', pharmacyId)
    .gte('timestamp', from)
    .lt('timestamp', toDate)
    .order('timestamp');
  if (error) throw error;
  return data ?? [];
}

export async function fetchNdcAuditHistory(facilityId, pharmacyId, ndc, month, year) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const toDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const { data, error } = await supabase
    .from('accumulator_audit_log')
    .select('*, users(email)')
    .eq('facility_id', facilityId)
    .eq('pharmacy_id', pharmacyId)
    .eq('ndc', ndc)
    .gte('timestamp', from)
    .lt('timestamp', toDate)
    .order('timestamp');
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, userEmail: r.users?.email ?? r.user_id }));
}
