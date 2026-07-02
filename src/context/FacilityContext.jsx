import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

const FacilityContext = createContext(null);

export function FacilityProvider({ children }) {
  const [facilities, setFacilities] = useState([]);
  const [pharmacies, setPharmacies] = useState([]);
  const [selectedFacilityId, setSelectedFacilityId] = useState('all');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [{ data: f }, { data: p }] = await Promise.all([
      supabase.from('facilities').select('*').order('name'),
      supabase.from('pharmacies').select('*, pharmacy_facilities(facility_id)').order('name'),
    ]);
    setFacilities(f ?? []);
    setPharmacies(p ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <FacilityContext.Provider
      value={{ facilities, pharmacies, selectedFacilityId, setSelectedFacilityId, loading, refresh }}
    >
      {children}
    </FacilityContext.Provider>
  );
}

export function useFacility() {
  const ctx = useContext(FacilityContext);
  if (!ctx) throw new Error('useFacility must be used within a FacilityProvider');
  return ctx;
}
