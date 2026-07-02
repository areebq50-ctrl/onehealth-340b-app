import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, Download, ArrowLeft, Loader2 } from 'lucide-react';
import { fetchClaimDetail } from '../lib/dashboardApi.js';
import { formatCurrency, formatQty } from '../lib/calculations.js';
import { exportDailyClaims } from '../lib/excelExport.js';
import { useToast } from '../context/ToastContext.jsx';
import { SkeletonTable } from '../components/common/Skeleton.jsx';

export default function DayDetail() {
  const { claimId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [claim, setClaim] = useState(null);
  const [lineItems, setLineItems] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const { claim: c, lineItems: li } = await fetchClaimDetail(claimId);
        if (cancelled) return;
        setClaim(c);
        setLineItems(li);
      } catch (err) {
        if (!cancelled) toast.error(`Failed to load claim: ${err.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [claimId]);

  if (loading) return <SkeletonTable rows={8} cols={9} />;
  if (!claim) return <p className="text-sm text-gray-500">Claim not found.</p>;

  const negativeCount = lineItems.filter((li) => li.qty_after !== null && Number(li.qty_after) < 0).length;

  return (
    <div className="space-y-6">
      <button className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-teal" onClick={() => navigate('/')}>
        <ArrowLeft className="h-4 w-4" /> Back to Dashboard
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-navy">
            {claim.pharmacies?.name} — {claim.claim_date}
          </h1>
          <p className="text-sm text-gray-500">
            {claim.facilities?.name} · Uploaded by {claim.users?.email} on {new Date(claim.uploaded_at).toLocaleString()}
          </p>
        </div>
        <button
          className="btn-secondary"
          onClick={() =>
            exportDailyClaims(claim, lineItems, {
              pharmacyName: claim.pharmacies?.name ?? 'pharmacy',
              facilityName: claim.facilities?.name ?? 'facility',
            })
          }
        >
          <Download className="h-4 w-4" /> Export to Excel
        </button>
      </div>

      {negativeCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" />
          {negativeCount} NDC{negativeCount > 1 ? 's' : ''} went negative on-hand from this claim.
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-auto">
          <table className="w-full min-w-max text-left text-sm">
            <thead className="sticky top-0 bg-surface-alt">
              <tr>
                {['NDC', 'Drug Name', 'Qty Dispensed', 'Pack Size', 'Packs Dispensed', '340B PPU', 'Reimbursement Owed', 'Qty Before', 'Qty After', 'Status'].map(
                  (h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-3 font-semibold text-navy">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li, i) => {
                const isNegative = li.qty_after !== null && Number(li.qty_after) < 0;
                return (
                  <tr
                    key={li.id}
                    className={`${i % 2 ? 'bg-surface-alt' : 'bg-white'} ${isNegative ? 'bg-red-50' : ''}`}
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{li.ndc}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{li.product_name ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{formatQty(li.qty_dispensed)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{li.pack_size ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{li.packs_dispensed !== null ? formatQty(li.packs_dispensed) : '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{formatCurrency(li.ppu_340b)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-semibold">{formatCurrency(li.reimbursement_owed)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{li.qty_before !== null ? formatQty(li.qty_before) : '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className={isNegative ? 'inline-flex items-center gap-1 font-semibold text-danger' : ''}>
                        {isNegative && <AlertTriangle className="h-3.5 w-3.5" />}
                        {li.qty_after !== null ? formatQty(li.qty_after) : '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {!li.matched ? (
                        <span className="badge bg-amber-50 text-warning">Unmatched</span>
                      ) : isNegative ? (
                        <span className="badge bg-red-50 text-danger">Negative</span>
                      ) : (
                        <span className="badge bg-green-50 text-success">OK</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-gray-100 bg-surface-alt px-6 py-4 text-sm font-semibold">
          Total Reimbursement: {formatCurrency(claim.total_reimbursement)}
        </div>
      </div>
    </div>
  );
}
