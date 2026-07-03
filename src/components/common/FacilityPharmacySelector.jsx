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
