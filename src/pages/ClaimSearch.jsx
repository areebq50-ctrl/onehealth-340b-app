import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search as SearchIcon, Eye, Download, Inbox, Trash2, Loader2 } from 'lucide-react';
import { useFacility } from '../context/FacilityContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { searchClaimBatches } from '../lib/dashboardApi.js';
import { deleteClaim } from '../lib/claimsApi.js';
import { formatCurrency } from '../lib/calculations.js';
import FacilityPharmacySelector from '../components/common/FacilityPharmacySelector.jsx';
import DataTable from '../components/common/DataTable.jsx';
import ScopeLabel from '../components/common/ScopeLabel.jsx';
import { SkeletonTable } from '../components/common/Skeleton.jsx';
import EmptyState from '../components/common/EmptyState.jsx';
import ExcelPreviewModal from '../components/files/ExcelPreviewModal.jsx';
import { exportDailyClaims } from '../lib/excelExport.js';
import { fetchClaimDetail } from '../lib/dashboardApi.js';

export default function ClaimSearch() {
  const { selectedFacilityId, selectedPharmacyId } = useFacility();
  const toast = useToast();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filenameQuery, setFilenameQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);
  const [previewBatch, setPreviewBatch] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  async function runSearch() {
    setLoading(true);
    try {
      const data = await searchClaimBatches({
        facilityId: selectedFacilityId,
        pharmacyId: selectedPharmacyId,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        filenameQuery: filenameQuery || null,
      });
      setResults(data);
    } catch (err) {
      toast.error(`Search failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFacilityId, selectedPharmacyId]);

  async function handleDownloadProcessed(claimId) {
    try {
      const { claim, lineItems } = await fetchClaimDetail(claimId);
      exportDailyClaims(claim, lineItems, {
        pharmacyName: claim.pharmacies?.name ?? 'pharmacy',
        facilityName: claim.facilities?.name ?? 'facility',
      });
    } catch (err) {
      toast.error(`Export failed: ${err.message}`);
    }
  }

  async function handleDelete(row) {
    if (
      !window.confirm(
        `Delete this entire claim batch (${row.claim_date}, ${row.pharmacyName})? This reverses its accumulator effect ` +
          `(dispensed qty added back, reimbursement removed) and cannot be undone.`
      )
    )
      return;
    setDeletingId(row.id);
    try {
      await deleteClaim(row.id);
      toast.success('Claim batch deleted and its accumulator effect reversed.');
      await runSearch();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  }

  const columns = [
    { key: 'claim_date', label: 'Claim Date', sortable: true },
    { key: 'facilityName', label: 'Facility', sortable: true },
    { key: 'pharmacyName', label: 'Pharmacy', sortable: true },
    { key: 'original_filename', label: 'Filename', sortable: true, render: (r) => r.original_filename ?? '—' },
    { key: 'uploaded_at', label: 'Uploaded', sortable: true, render: (r) => new Date(r.uploaded_at).toLocaleString() },
    { key: 'uploadedByEmail', label: 'Uploaded By', sortable: true },
    { key: 'claim_line_count', label: 'Lines', sortable: true, render: (r) => r.claim_line_count ?? '—' },
    { key: 'distinct_rx_count', label: 'Distinct RX', sortable: true, render: (r) => r.distinct_rx_count ?? '—' },
    { key: 'distinct_ndc_count', label: 'Distinct NDC', sortable: true, render: (r) => r.distinct_ndc_count ?? '—' },
    { key: 'matched_count', label: 'Matched', sortable: true, render: (r) => r.matched_count ?? 0 },
    {
      key: 'unmatched_count',
      label: 'Unmatched',
      sortable: true,
      render: (r) =>
        r.unmatched_count > 0 ? (
          <button
            className="font-semibold text-danger hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/claims/${r.id}`, { state: { tab: 'Replenishment by NDC' } });
            }}
            title="View unmatched NDCs for this batch"
          >
            {r.unmatched_count}
          </button>
        ) : (
          0
        ),
    },
    { key: 'total_reimbursement', label: 'Reimbursement', sortable: true, render: (r) => formatCurrency(r.total_reimbursement) },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <span className="badge bg-green-50 text-success">{r.status}</span> },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          {r.file_path && (
            <button className="btn-secondary px-2 py-1" title="Preview original file" onClick={() => setPreviewBatch(r)}>
              <Eye className="h-3.5 w-3.5" />
            </button>
          )}
          <button className="btn-secondary px-2 py-1" title="Download processed results" onClick={() => handleDownloadProcessed(r.id)}>
            <Download className="h-3.5 w-3.5" />
          </button>
          {isAdmin && (
            <button
              className="btn-secondary px-2 py-1 text-danger"
              title="Delete claim batch"
              disabled={deletingId === r.id}
              onClick={() => handleDelete(r)}
            >
              {deletingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-navy">Claim Search &amp; File History</h1>
        <p className="text-sm text-gray-500">Find any uploaded claim batch — click a row to open its full results.</p>
      </div>

      <ScopeLabel />

      <div className="card space-y-4 p-5">
        <FacilityPharmacySelector />
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label-text">Claim Date From</label>
            <input type="date" className="input-field" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="label-text">Claim Date To</label>
            <input type="date" className="input-field" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="label-text">Filename Contains</label>
            <input className="input-field" value={filenameQuery} onChange={(e) => setFilenameQuery(e.target.value)} placeholder="e.g. JUNE_25" />
          </div>
          <button className="btn-primary" onClick={runSearch}>
            <SearchIcon className="h-4 w-4" /> Search
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonTable rows={8} cols={10} />
      ) : results.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No claim batches found"
          message="No uploaded claims match this facility/pharmacy and date range yet."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={results}
          rowKey={(r) => r.id}
          searchPlaceholder="Search within results..."
          onRowClick={(r) => navigate(`/claims/${r.id}`)}
        />
      )}

      <ExcelPreviewModal
        open={Boolean(previewBatch)}
        onClose={() => setPreviewBatch(null)}
        filePath={previewBatch?.file_path}
        meta={{
          filename: previewBatch?.original_filename ?? previewBatch?.file_path,
          facilityName: previewBatch?.facilityName,
          pharmacyName: previewBatch?.pharmacyName,
          claimDate: previewBatch?.claim_date,
          uploadedAt: previewBatch ? new Date(previewBatch.uploaded_at).toLocaleString() : '',
        }}
      />
    </div>
  );
}
