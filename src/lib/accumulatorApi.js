import { supabase } from './supabaseClient.js';

/** Distinct (month, year) periods on record for a facility, newest first. */
export async function fetchPeriods(facilityId) {
  const { data, error } = await supabase
    .from('accumulator')
    .select('month, year')
    .eq('facility_id', facilityId);
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

export async function fetchAccumulatorRows(facilityId, month, year) {
  const { data, error } = await supabase
    .from('accumulator')
    .select('*')
    .eq('facility_id', facilityId)
    .eq('month', month)
    .eq('year', year)
    .order('product_name');
  if (error) throw error;
  return data ?? [];
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

export async function addAccumulatorRow({ facilityId, month, year, ndc, productName, packSize, qtyOnHand, expDay, price340b, ppu340b, cin, manufacturer }) {
  const { data, error } = await supabase.rpc('add_accumulator_row', {
    p_facility_id: facilityId,
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

export async function rolloverMonth({ facilityId, fromMonth, fromYear, toMonth, toYear }) {
  const { data, error } = await supabase.rpc('rollover_month', {
    p_facility_id: facilityId,
    p_from_month: fromMonth,
    p_from_year: fromYear,
    p_to_month: toMonth,
    p_to_year: toYear,
  });
  if (error) throw error;
  return data;
}

export async function importAccumulatorRows({ facilityId, month, year, rows }) {
  const { data, error } = await supabase.rpc('import_accumulator_rows', {
    p_facility_id: facilityId,
    p_month: month,
    p_year: year,
    p_rows: rows,
  });
  if (error) throw error;
  return data;
}
