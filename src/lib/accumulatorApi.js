import { supabase } from './supabaseClient.js';

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
  const { error } = await supabase.rpc('edit_accumulator_row', {
    p_id: row.id,
    p_product_name: row.product_name,
    p_pack_size: row.pack_size,
    p_price_340b: row.price_340b,
    p_ppu_340b: row.ppu_340b,
    p_exp_day: row.exp_day || null,
    p_qty_on_hand: row.qty_on_hand,
    p_cin: row.cin,
    p_manufacturer: row.manufacturer,
  });
  if (error) throw error;
}

export async function deleteAccumulatorRow(id) {
  const { error } = await supabase.rpc('delete_accumulator_row', { p_id: id });
  if (error) throw error;
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
