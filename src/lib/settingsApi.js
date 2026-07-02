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
  const { error } = await supabase.from('users').update({ active }).eq('id', userId);
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

export async function addFacility({ name, shortCode, notes }) {
  const { data, error } = await supabase.from('facilities').insert({ name, short_code: shortCode, notes }).select().single();
  if (error) throw error;
  return data;
}

export async function addPharmacy({ name, facilityIds }) {
  const { data: pharmacy, error } = await supabase.from('pharmacies').insert({ name }).select().single();
  if (error) throw error;

  if (facilityIds.length > 0) {
    const { error: linkErr } = await supabase
      .from('pharmacy_facilities')
      .insert(facilityIds.map((facilityId) => ({ pharmacy_id: pharmacy.id, facility_id: facilityId })));
    if (linkErr) throw linkErr;
  }
  return pharmacy;
}
