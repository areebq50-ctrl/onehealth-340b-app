import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';

const FacilityContext = createContext(null);

const STORAGE_KEY = 'onehealth340b.scope';

function loadPersistedScope() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistScope(facilityId, pharmacyId) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ facilityId, pharmacyId }));
  } catch {
    // localStorage unavailable (e.g. private browsing) — scope just won't persist across reloads.
  }
}

export function FacilityProvider({ children }) {
  const [facilities, setFacilities] = useState([]);
  const [pharmacies, setPharmacies] = useState([]);
  const [selectedFacilityId, setSelectedFacilityIdRaw] = useState('all');
  const [selectedPharmacyId, setSelectedPharmacyIdRaw] = useState('all');
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

  // Restore persisted scope once facilities/pharmacies are loaded, re-validating
  // the pharmacy still belongs to the facility (associations may have changed).
  useEffect(() => {
    if (loading || facilities.length === 0) return;
    const persisted = loadPersistedScope();
    if (!persisted.facilityId) return;
    const facilityStillExists = persisted.facilityId === 'all' || facilities.some((f) => f.id === persisted.facilityId);
    if (!facilityStillExists) return;
    setSelectedFacilityIdRaw(persisted.facilityId);

    if (persisted.pharmacyId && persisted.pharmacyId !== 'all') {
      const pharmacy = pharmacies.find((p) => p.id === persisted.pharmacyId);
      const belongsToFacility = pharmacy && (pharmacy.pharmacy_facilities ?? []).some((pf) => pf.facility_id === persisted.facilityId);
      setSelectedPharmacyIdRaw(belongsToFacility ? persisted.pharmacyId : 'all');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const pharmaciesForSelectedFacility = useMemo(() => {
    if (selectedFacilityId === 'all') return pharmacies;
    return pharmacies.filter((p) => (p.pharmacy_facilities ?? []).some((pf) => pf.facility_id === selectedFacilityId));
  }, [pharmacies, selectedFacilityId]);

  // Changing facility clears the pharmacy selection unless it's still valid
  // for the new facility (never silently keep an invalid cross-facility pharmacy).
  const setSelectedFacilityId = useCallback(
    (facilityId) => {
      setSelectedFacilityIdRaw(facilityId);
      setSelectedPharmacyIdRaw((currentPharmacyId) => {
        if (currentPharmacyId === 'all') {
          persistScope(facilityId, 'all');
          return 'all';
        }
        const pharmacy = pharmacies.find((p) => p.id === currentPharmacyId);
        const stillValid =
          facilityId !== 'all' && pharmacy && (pharmacy.pharmacy_facilities ?? []).some((pf) => pf.facility_id === facilityId);
        const nextPharmacyId = stillValid ? currentPharmacyId : 'all';
        persistScope(facilityId, nextPharmacyId);
        return nextPharmacyId;
      });
    },
    [pharmacies]
  );

  const setSelectedPharmacyId = useCallback(
    (pharmacyId) => {
      setSelectedPharmacyIdRaw(pharmacyId);
      persistScope(selectedFacilityId, pharmacyId);
    },
    [selectedFacilityId]
  );

  const selectedFacility = facilities.find((f) => f.id === selectedFacilityId) ?? null;
  const selectedPharmacy = pharmacies.find((p) => p.id === selectedPharmacyId) ?? null;
  const isAllPharmacies = selectedPharmacyId === 'all';

  return (
    <FacilityContext.Provider
      value={{
        facilities,
        pharmacies,
        pharmaciesForSelectedFacility,
        selectedFacilityId,
        setSelectedFacilityId,
        selectedPharmacyId,
        setSelectedPharmacyId,
        selectedFacility,
        selectedPharmacy,
        isAllPharmacies,
        loading,
        refresh,
      }}
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
