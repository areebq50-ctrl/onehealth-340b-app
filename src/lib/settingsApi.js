import { supabase } from './supabaseClient.js';

export async function fetchUsers() {
  const { data, error } = await supabase.from('users').select('*').order('email');
  if (error) throw error;
  return data ?? [];
}

export async function updateUserRole(userId, role) {
  const { error } = await supabase.from('users').update({ role }).eq('id', userId);
  if (error) throw error;
}

export async function setUserActive(userId, active) {
  // Goes through the set_user_active RPC rather than a direct table update:
  // the users_update_admin RLS policy requires the caller to already be an
  // active admin, which deadlocks an admin trying to reactivate their own
  // account after going inactive. The RPC checks role='admin' only.
  const { error } = await supabase.rpc('set_user_active', { p_user_id: userId, p_active: active });
  if (error) throw error;
}

export async function inviteUser(email, role) {
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action: 'invite', email, role },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Permanently deletes an account (auth user + profile row, which cascades).
 * Blocked at the database level — and surfaced here as a clear error — for
 * any account with claims, uploads, or audit history, since that history
 * must stay attributable and immutable. Use setUserActive() to deactivate
 * a real, in-use account instead; this is for accounts that should never
 * have existed (invited by mistake, duplicate, never logged in).
 */
export async function deleteUserAccount(userId) {
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action: 'delete', userId },
  });
  if (error) {
    let detail = error.message;
    if (error.context && typeof error.context.json === 'function') {
      try {
        const body = await error.context.json();
        if (body?.error) detail = body.error;
      } catch {
        // response body wasn't JSON — fall back to the generic message
      }
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function addFacility({ name, shortCode, notes }) {
  const { data, error } = await supabase.from('facilities').insert({ name, short_code: shortCode, notes }).select().single();
  if (error) throw error;
  return data;
}

export async function addPharmacy({ name, facilityIds }) {
  const trimmed = name.trim();
  const { data: existing, error: checkErr } = await supabase.from('pharmacies').select('id').ilike('name', trimmed).maybeSingle();
  if (checkErr) throw checkErr;
  if (existing) throw new Error(`A pharmacy named "${trimmed}" already exists.`);

  const { data: pharmacy, error } = await supabase.from('pharmacies').insert({ name: trimmed }).select().single();
  if (error) throw error;

  if (facilityIds.length > 0) {
    const { error: linkErr } = await supabase
      .from('pharmacy_facilities')
      .insert(facilityIds.map((facilityId) => ({ pharmacy_id: pharmacy.id, facility_id: facilityId })));
    if (linkErr) throw linkErr;
  }
  return pharmacy;
}

/** Renames a pharmacy and replaces its facility associations, atomically, via RPC (admin-only). */
export async function updatePharmacy({ id, name, facilityIds }) {
  const { error } = await supabase.rpc('update_pharmacy', {
    p_id: id,
    p_name: name,
    p_facility_ids: facilityIds,
  });
  if (error) throw error;
}

/**
 * Deletes a pharmacy outright (admin-only). Blocked server-side — not
 * silently allowed — if the pharmacy already has accumulator, claims, or
 * order history, so real data is never discarded as a side effect.
 */
export async function deletePharmacy(id) {
  const { error } = await supabase.rpc('delete_pharmacy', { p_id: id });
  if (error) throw error;
}
