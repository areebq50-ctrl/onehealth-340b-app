import { ChevronRight } from 'lucide-react';
import { useFacility } from '../../context/FacilityContext.jsx';

/** "Currently viewing: Heartland → Blue Swan → July 2026" — shared across every scoped page. */
export default function ScopeLabel({ period, className = '' }) {
  const { selectedFacilityId, selectedFacility, selectedPharmacyId, selectedPharmacy } = useFacility();

  const facilityLabel = selectedFacilityId === 'all' ? 'All Facilities' : selectedFacility?.name ?? '—';
  const pharmacyLabel = selectedPharmacyId === 'all' ? 'All Pharmacies' : selectedPharmacy?.name ?? '—';

  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-sm text-gray-500 ${className}`}>
      <span className="font-medium text-gray-400">Currently viewing:</span>
      <span className="font-semibold text-navy">{facilityLabel}</span>
      <ChevronRight className="h-3.5 w-3.5" />
      <span className={`font-semibold ${selectedPharmacyId === 'all' ? 'text-teal-700' : 'text-navy'}`}>{pharmacyLabel}</span>
      {period && (
        <>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="font-semibold text-navy">{period}</span>
        </>
      )}
    </div>
  );
}
