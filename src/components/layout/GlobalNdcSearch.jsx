import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2 } from 'lucide-react';
import { useFacility } from '../../context/FacilityContext.jsx';
import { searchAccumulatorGlobal } from '../../lib/accumulatorApi.js';
import { formatQty } from '../../lib/calculations.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Jump straight to a drug by NDC or name instead of manually reselecting
 * facility -> pharmacy -> period -> scrolling to find it. Searches across
 * every facility/pharmacy the user can see; picking a result sets scope
 * and navigates to Accumulator pre-filtered to that NDC.
 */
export default function GlobalNdcSearch() {
  const navigate = useNavigate();
  const { setSelectedFacilityId, setSelectedPharmacyId } = useFacility();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      searchAccumulatorGlobal(q)
        .then((data) => {
          if (!cancelled) setResults(data);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleSelect(r) {
    setSelectedFacilityId(r.facility_id);
    setSelectedPharmacyId(r.pharmacy_id);
    setOpen(false);
    setQuery('');
    navigate(`/accumulator?ndc=${encodeURIComponent(r.ndc)}`);
  }

  return (
    <div className="relative w-full max-w-xs" ref={boxRef}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        className="input-field pl-9"
        placeholder="Find a drug by NDC or name..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400" />}

      {open && query.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {loading ? (
            <p className="p-3 text-sm text-gray-400">Searching...</p>
          ) : results.length === 0 ? (
            <p className="p-3 text-sm text-gray-400">No matches.</p>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                className="flex w-full flex-col items-start gap-0.5 border-b border-gray-100 px-3 py-2 text-left last:border-0 hover:bg-teal-50"
                onClick={() => handleSelect(r)}
              >
                <span className="text-sm font-medium text-navy">{r.product_name}</span>
                <span className="text-xs text-gray-500">
                  <span className="font-mono">{r.ndc}</span> · {r.facilityName} → {r.pharmacyName} · {MONTH_NAMES[r.month - 1]} {r.year} ·
                  Qty {formatQty(r.qty_on_hand)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
