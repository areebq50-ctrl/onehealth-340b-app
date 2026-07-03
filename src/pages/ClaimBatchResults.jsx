import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, Download, ArrowLeft, Eye, ClipboardList, Package, ScrollText, FileSpreadsheet } from 'lucide-react';
import { fetchClaimDetail } from '../lib/dashboardApi.js';
import { fetchClaimRawLines, fetchAuditLogByClaim } from '../lib/claimsApi.js';
import { formatCurrency, formatQty, packsToOrder, Decimal } from '../lib/calculations.js';
import { exportDailyClaims, exportReplenishmentReport, exportProcessedWorkbook } from '../lib/excelExport.js';
import { useToast } from '../context/ToastContext.jsx';
import { SkeletonTable } from '../components/common/Skeleton.jsx';
import EmptyState from '../components/common/EmptyState.jsx';
import DataTable from '../components/common/DataTable.jsx';
import ExcelPreviewModal from '../components/files/ExcelPreviewModal.jsx';

const TABS = ['Overview', 'All Claims', 'Replenishment by NDC', 'Accumulator Changes & Audit'];

function StatCard({ label, value, tone = 'navy' }) {
  const tones = { navy: 'text-navy', teal: 'text-teal-700', coral: 'text-coral-700', danger: 'text-danger', warning: 'text-warning' };
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tones[tone]}`}>{value}</p>
    </div>
  );
}

export default function ClaimBatchResults() {
  const { claimId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [claim, setClaim] = useState(null);
  const [lineItems, setLineItems] = useState([]);
  const [rawLines, setRawLines] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [tab, setTab] = useState('Overview');
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [{ claim: c, lineItems: li }, raw, audit] = await Promise.all([
          fetchClaimDetail(claimId),
          fetchClaimRawLines(claimId),
          fetchAuditLogByClaim(claimId),
        ]);
        if (cancelled) return;
        setClaim(c);
        setLineItems(li);
        setRawLines(raw);
        setAuditLog(audit);
      } catch (err) {
        if (!cancelled) toast.error(`Failed to load claim batch: ${err.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimId]);

  const replenishment = useMemo(() => {
    return lineItems
      .filter((li) => li.matched)
      .map((li) => {
        const r = packsToOrder(li.qty_after, li.pack_size);
        const rxCount = new Set(rawLines.filter((rl) => rl.ndc === li.ndc).map((rl) => rl.rx_number).filter(Boolean)).size;
        return {
          ndc: li.ndc,
          productName: li.product_name,
          qtyDispensed: li.qty_dispensed,
          lineCount: rawLines.filter((rl) => rl.ndc === li.ndc).length,
          rxCount,
          packSize: li.pack_size,
          qtyBefore: li.qty_before,
          qtyAfter: li.qty_after,
          shortage: r.shortage,
          exactPacks: r.exactPacks,
          recommendedPacks: r.recommendedPacks,
          matched: true,
          flagged: r.flagged,
        };
      });
  }, [lineItems, rawLines]);

  const replenishmentTotals = useMemo(() => {
    const totalRecommendedPacks = replenishment.reduce(
      (sum, r) => (r.recommendedPacks ? sum.plus(r.recommendedPacks) : sum),
      new Decimal(0)
    );
    return { totalRecommendedPacks: totalRecommendedPacks.toString() };
  }, [replenishment]);

  if (loading) return <SkeletonTable rows={8} cols={9} />;
  if (!claim) return <EmptyState title="Claim batch not found" message="This claim may have been removed or you may not have access to it." />;

  const negativeCount = lineItems.filter((li) => li.qty_after !== null && Number(li.qty_after) < 0).length;

  return (
    <div className="space-y-6">
      <button className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-teal" onClick={() => navigate('/claims')}>
        <ArrowLeft className="h-4 w-4" /> Back to Claim Search
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-navy">
            {claim.facilities?.name} → {claim.pharmacies?.name} — {claim.claim_date}
          </h1>
          <p className="text-sm text-gray-500">
            {claim.original_filename ?? 'Manual entry'} · Uploaded by {claim.users?.email} on {new Date(claim.uploaded_at).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {claim.file_path && (
            <button className="btn-secondary" onClick={() => setPreviewOpen(true)}>
              <Eye className="h-4 w-4" /> Preview Original
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() =>
              exportProcessedWorkbook(rawLines.length > 0 ? rawLines.map((rl) => ({ ...rl, matched: rl.matched })) : lineItems, {
                pharmacyName: claim.pharmacies?.name ?? 'pharmacy',
                facilityName: claim.facilities?.name ?? 'facility',
                claimDate: claim.claim_date,
              })
            }
          >
            <FileSpreadsheet className="h-4 w-4" /> Download Processed
          </button>
          <button
            className="btn-secondary"
            onClick={() =>
              exportDailyClaims(claim, lineItems, {
                pharmacyName: claim.pharmacies?.name ?? 'pharmacy',
                facilityName: claim.facilities?.name ?? 'facility',
              })
            }
          >
            <Download className="h-4 w-4" /> Download Standardized Report
          </button>
        </div>
      </div>

      {negativeCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" />
          {negativeCount} NDC{negativeCount > 1 ? 's' : ''} went negative on-hand from this claim.
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${
              tab === t ? 'border-teal text-teal-700' : 'border-transparent text-gray-500 hover:text-navy'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <StatCard label="Source Rows" value={claim.total_rows ?? '—'} />
            <StatCard label="Valid Rows" value={claim.valid_rows ?? '—'} />
            <StatCard label="Invalid / Rejected Rows" value={claim.invalid_rows ?? 0} tone={claim.invalid_rows > 0 ? 'warning' : 'navy'} />
            <StatCard label="Claim Line Count" value={claim.claim_line_count ?? rawLines.length} />
            <StatCard label="Distinct RX Count" value={claim.distinct_rx_count ?? '—'} />
            <StatCard label="Distinct NDC Count" value={claim.distinct_ndc_count ?? '—'} />
            <StatCard label="Total Qty Dispensed" value={formatQty(claim.total_qty_dispensed)} />
            <StatCard label="Matched NDCs" value={claim.matched_count ?? 0} tone="teal" />
            <StatCard label="Unmatched NDCs" value={claim.unmatched_count ?? 0} tone={claim.unmatched_count > 0 ? 'coral' : 'navy'} />
            <StatCard label="Estimated Reimbursement" value={formatCurrency(claim.total_reimbursement)} tone="teal" />
            <StatCard label="Total Full Packages to Order" value={replenishmentTotals.totalRecommendedPacks} tone="warning" />
            <StatCard label="Negative On-Hand NDCs" value={negativeCount} tone={negativeCount > 0 ? 'danger' : 'navy'} />
          </div>
          <p className="text-xs text-gray-400">
            &quot;Claim line count&quot;, &quot;distinct RX count&quot;, and &quot;distinct NDC count&quot; are different measures — see the All Claims and Replenishment
            tabs for the full breakdown. Total packages above is for operational convenience only; the NDC-by-NDC list in Replenishment is the
            authoritative requirement (packages from different NDCs are not interchangeable).
          </p>
        </div>
      )}

      {tab === 'All Claims' && (
        <AllClaimsTab rows={rawLines} />
      )}

      {tab === 'Replenishment by NDC' && (
        <ReplenishmentTab
          rows={replenishment}
          onExport={() =>
            exportReplenishmentReport(replenishment, {
              facilityName: claim.facilities?.name,
              pharmacyName: claim.pharmacies?.name,
              claimDate: claim.claim_date,
            })
          }
        />
      )}

      {tab === 'Accumulator Changes & Audit' && <AuditTab rows={auditLog} />}

      <ExcelPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        filePath={claim.file_path}
        meta={{
          filename: claim.original_filename ?? claim.file_path,
          facilityName: claim.facilities?.name,
          pharmacyName: claim.pharmacies?.name,
          claimDate: claim.claim_date,
          uploadedAt: new Date(claim.uploaded_at).toLocaleString(),
        }}
      />
    </div>
  );
}

function AllClaimsTab({ rows }) {
  if (rows.length === 0) {
    return <EmptyState icon={ClipboardList} title="No claim line detail available" message="This batch has no per-RX ledger rows recorded." />;
  }
  const columns = [
    { key: 'rx_number', label: 'RX#', sortable: true },
    { key: 'ndc', label: 'NDC', sortable: true, render: (r) => <span className="font-mono text-xs">{r.ndc}</span> },
    { key: 'product_name', label: 'Drug Name', sortable: true },
    { key: 'qty_dispensed', label: 'Qty', sortable: true, accessor: (r) => Number(r.qty_dispensed ?? 0), render: (r) => formatQty(r.qty_dispensed) },
    { key: 'days_supply', label: 'DS', sortable: true },
    { key: 'date_filled', label: 'Date Filled', sortable: true },
    { key: 'date_written', label: 'Date Written', sortable: true },
    { key: 'refill_no', label: 'Refill No.', sortable: true },
    { key: 'primary_paid', label: 'Primary Paid', sortable: true, render: (r) => formatCurrency(r.primary_paid) },
    { key: 'patient_paid', label: 'Patient Paid', sortable: true, render: (r) => formatCurrency(r.patient_paid) },
    { key: 'total_paid', label: 'Total', sortable: true, render: (r) => formatCurrency(r.total_paid) },
    { key: 'primary_payer', label: 'Primary', sortable: true },
    { key: 'bin', label: 'BIN', sortable: true },
    { key: 'pcn', label: 'PCN', sortable: true },
    { key: 'group_code', label: 'Group', sortable: true },
    { key: 'member_id', label: 'Member ID', sortable: true },
    { key: 'prescriber', label: 'Prescriber', sortable: true },
    { key: 'prescriber_npi', label: 'Prescriber NPI', sortable: true },
    {
      key: 'matched',
      label: 'Match Status',
      sortable: true,
      render: (r) => (r.matched ? <span className="badge bg-green-50 text-success">Matched</span> : <span className="badge bg-amber-50 text-warning">Unmatched</span>),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      searchPlaceholder="Search RX#, NDC, drug name, prescriber..."
      pageSize={50}
      rowClassName={(r) => (!r.matched ? 'bg-amber-50/40' : '')}
    />
  );
}

function ReplenishmentTab({ rows, onExport }) {
  if (rows.length === 0) {
    return <EmptyState icon={Package} title="No replenishment data is available for this claim batch" message="No matched NDCs were dispensed in this batch." />;
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn-secondary" onClick={onExport}>
          <Download className="h-4 w-4" /> Download Standardized Replenishment Report
        </button>
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-auto">
          <table className="w-full min-w-max text-left text-sm">
            <thead className="sticky top-0 bg-surface-alt">
              <tr>
                {['NDC', 'Drug Name', 'Lines', 'Distinct RX', 'Qty Dispensed', 'Pack Size', 'Qty Before', 'Qty After', 'Shortage', 'Exact Packs', 'Recommended Packs'].map(
                  (h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-3 font-semibold text-navy">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.ndc} className={`${i % 2 ? 'bg-surface-alt' : 'bg-white'} ${r.recommendedPacks?.gt?.(0) ? 'bg-amber-50/40' : ''}`}>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{r.ndc}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{r.productName}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{r.lineCount}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{r.rxCount}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{formatQty(r.qtyDispensed)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{r.packSize ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{formatQty(r.qtyBefore)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    <span className={Number(r.qtyAfter) < 0 ? 'font-semibold text-danger' : ''}>{formatQty(r.qtyAfter)}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">{r.flagged ? '—' : formatQty(r.shortage)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">{r.flagged ? 'N/A (no pack size)' : formatQty(r.exactPacks, 4)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-semibold">{r.flagged ? '—' : formatQty(r.recommendedPacks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AuditTab({ rows }) {
  if (rows.length === 0) {
    return <EmptyState icon={ScrollText} title="No audit entries for this batch" message="No accumulator changes were recorded." />;
  }
  return (
    <div className="card overflow-hidden">
      <div className="overflow-auto">
        <table className="w-full min-w-max text-left text-sm">
          <thead className="sticky top-0 bg-surface-alt">
            <tr>
              {['Timestamp', 'User', 'NDC', 'Product', 'Prior Qty', 'Qty Change', 'New Qty', 'Reimbursement', 'Action'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 py-3 font-semibold text-navy">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                <td className="whitespace-nowrap px-4 py-2.5 text-xs">{new Date(r.timestamp).toLocaleString()}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{r.userEmail}</td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{r.ndc}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{r.product_name}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{formatQty(r.prior_qty)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{formatQty(r.qty_dispensed)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{formatQty(r.new_qty)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{formatCurrency(r.reimbursement_amount)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <span className="badge bg-gray-100 text-gray-600">{r.action_type}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
