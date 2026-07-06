import { useEffect } from 'react';
import { useFacility } from '../../context/FacilityContext.jsx';

/**
 * Shared Facility + Pharmacy selector used identically across Dashboard,
 * Accumulator, Upload Claims, Reports, and File History — cascading
 * (pharmacy list always follows the selected facility) and backed by
 * FacilityContext so the scope is consistent and persisted across pages.
 */
export default function FacilityPharmacySelector({ includeAllFacilities = true, className = '' }) {
  const { facilities, pharmaciesForSelectedFacility, selectedFacilityId, setSelectedFacilityId, selectedPharmacyId, setSelectedPharmacyId } =
    useFacility();

  // Pages that pass includeAllFacilities={false} (Upload Claims, Accumulator,
  // Reports) never render an "All Facilities" <option> — but the shared
  // scope can still default to 'all' (e.g. a first-ever visit, or coming
  // from a page that does allow "all"). A <select value="all"> with no
  // matching option just silently shows the first real facility while
  // React's actual state stays stuck at 'all', which in turn keeps the
  // Pharmacy dropdown disabled and blocks every write action — with no
  // visible sign anything is wrong. Auto-select the first real facility
  // here so the visible selection and the actual scope state always agree.
  useEffect(() => {
    if (!includeAllFacilities && selectedFacilityId === 'all' && facilities.length > 0) {
      setSelectedFacilityId(facilities[0].id);
    }
  }, [includeAllFacilities, selectedFacilityId, facilities, setSelectedFacilityId]);

  return (
    <div className={`flex flex-wrap items-end gap-4 ${className}`}>
      <div>
        <label className="label-text">Facility</label>
        <select className="input-field" value={selectedFacilityId} onChange={(e) => setSelectedFacilityId(e.target.value)}>
          {includeAllFacilities && <option value="all">All Facilities</option>}
          {facilities.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label-text">Pharmacy</label>
        <select
          className="input-field"
          value={selectedPharmacyId}
          disabled={selectedFacilityId === 'all'}
          onChange={(e) => setSelectedPharmacyId(e.target.value)}
        >
          <option value="all">All Pharmacies</option>
          {pharmaciesForSelectedFacility.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
