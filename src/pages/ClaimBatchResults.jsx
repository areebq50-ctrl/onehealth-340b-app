import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { AlertTriangle, Download, ArrowLeft, Eye, ClipboardList, Package, ScrollText, FileSpreadsheet, Wrench, Loader2, Trash2 } from 'lucide-react';
import { fetchClaimDetail } from '../lib/dashboardApi.js';
import { fetchClaimRawLines, fetchAuditLogByClaim, findAccumulatorRow, deleteClaim } from '../lib/claimsApi.js';
import { confirmReplenishmentOrder } from '../lib/accumulatorApi.js';
import { formatCurrency, formatQty, packsToOrder, signedPacksToOrder, Decimal } from '../lib/calculations.js';
import { exportDailyClaims, exportReplenishmentReport, exportProcessedWorkbook } from '../lib/excelExport.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { SkeletonTable } from '../components/common/Skeleton.jsx';
import EmptyState from '../components/common/EmptyState.jsx';
import DataTable from '../components/common/DataTable.jsx';
import ExcelPreviewModal from '../components/files/ExcelPreviewModal.jsx';
import UnmatchedNdcModal from '../components/claims/UnmatchedNdcModal.jsx';
import BulkAssignNdcModal from '../components/claims/BulkAssignNdcModal.jsx';

const TABS = ['Overview', 'All Claims', 'Replenishment by NDC', 'Accumulator Changes & Audit'];

function StatCard({ label, value, tone = 'navy', onClick }) {
  const tones = { navy: 'text-navy', teal: 'text-teal-700', coral: 'text-coral-700', danger: 'text-danger', warning: 'text-warning' };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`card p-4 text-left ${onClick ? 'cursor-pointer transition-shadow hover:shadow-md' : ''}`} onClick={onClick}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tones[tone]}`}>{value}</p>
    </Tag>
  );
}

export default function ClaimBatchResults() {
  const { claimId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [loading, setLoading] = useState(true);
  const [claim, setClaim] = useState(null);
  const [lineItems, setLineItems] = useState([]);
  const [rawLines, setRawLines] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [tab, setTab] = useState(() => (TABS.includes(location.state?.tab) ? location.state.tab : 'Overview'));
  const [replenStatusFilter, setReplenStatusFilter] = useState(() => (location.state?.filter === 'unmatched' ? 'unmatched' : 'all'));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState(null);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [orderingId, setOrderingId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const unmatchedLineItems = lineItems.filter((li) => !li.matched && !li.skip_reason);

  function goToUnmatched() {
    setReplenStatusFilter('unmatched');
    setTab('Replenishment by NDC');
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ claim: c, lineItems: li }, raw, audit] = await Promise.all([
        fetchClaimDetail(claimId),
        fetchClaimRawLines(claimId),
        fetchAuditLogByClaim(claimId),
      ]);
      setClaim(c);
      setLineItems(li);
      setRawLines(raw);
      setAuditLog(audit);
    } catch (err) {
      toast.error(`Failed to load claim batch: ${err.message}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimId]);

  useEffect(() => {
    load();
  }, [load]);

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
          price340b: li.price_340b,
          shortage: r.shortage,
          exactPacks: r.exactPacks,
          recommendedPacks: r.recommendedPacks,
          matched: true,
          flagged: r.flagged,
        };
      });
  }, [lineItems, rawLines]);

  // Daily results — every NDC from this claim, matched or not, with the
  // exact 13-column spec: NDC | Product Name | Pack Size | Starting Balance
  // | Qty Dispensed Today | New Balance | Packs to Order | 340B PPU |
  // Reimbursement Owed | CIN | Manufacturer | Expiry Date | Status.
  const dailyResults = useMemo(() => {
    return lineItems.map((li) => {
      if (!li.matched) {
        return {
          lineItemId: li.id,
          ndc: li.ndc,
          productName: li.product_name,
          packSize: null,
          startingBalance: null,
          qtyDispensedToday: li.qty_dispensed,
          newBalance: null,
          signed: null,
          ppu340b: null,
          reimbursementOwed: null,
          cin: null,
          manufacturer: null,
          expDay: null,
          matched: false,
          skipReason: li.skip_reason,
          status: li.skip_reason ? 'skipped' : 'unmatched',
        };
      }
      const s = signedPacksToOrder(li.qty_after, li.pack_size);
      const status = s.flagged ? 'unmatched' : s.value.gt(0) ? 'red' : 'green';
      return {
        lineItemId: li.id,
        ndc: li.ndc,
        productName: li.product_name,
        packSize: li.pack_size,
        startingBalance: li.qty_before,
        qtyDispensedToday: li.qty_dispensed,
        newBalance: li.qty_after,
        signed: s.value,
        ppu340b: li.ppu_340b,
        reimbursementOwed: li.reimbursement_owed,
        cin: li.cin,
        manufacturer: li.manufacturer,
        expDay: li.exp_day,
        matched: true,
        skipReason: null,
        status,
      };
    });
  }, [lineItems]);

  const orderPanelRows = useMemo(
    () =>
      replenishment
        .filter((r) => r.recommendedPacks?.gt?.(0))
        .map((r) => ({
          ...r,
          totalOrderCost: r.price340b !== null && r.price340b !== undefined ? r.recommendedPacks.times(r.price340b) : null,
        })),
    [replenishment]
  );

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

  async function handleDeleteClaim() {
    if (
      !window.confirm(
        `Delete this entire claim batch (${claim.claim_date}, ${claim.pharmacies?.name})? This reverses its accumulator effect ` +
          `(dispensed qty added back, reimbursement removed) and cannot be undone.`
      )
    )
      return;
    setDeleting(true);
    try {
      await deleteClaim(claim.id);
      toast.success('Claim batch deleted and its accumulator effect reversed.');
      navigate('/claims');
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
      setDeleting(false);
    }
  }

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
          {isAdmin && (
            <button className="btn-secondary text-danger" onClick={handleDeleteClaim} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete Claim Batch
            </button>
          )}
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

      {/* All four tabs stay mounted and are only hidden via CSS, not
          conditionally rendered — DataTable's search/sort/pagination state
          (and anything else local to a tab) used to reset every time you
          switched away and back, which read as the page "reloading". */}
      <div className={tab === 'Overview' ? 'space-y-6' : 'hidden'}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard label="Source Rows" value={claim.total_rows ?? '—'} />
          <StatCard label="Valid Rows" value={claim.valid_rows ?? '—'} />
          <StatCard label="Invalid / Rejected Rows" value={claim.invalid_rows ?? 0} tone={claim.invalid_rows > 0 ? 'warning' : 'navy'} />
          <StatCard label="Claim Line Count" value={claim.claim_line_count ?? rawLines.length} />
          <StatCard label="Distinct RX Count" value={claim.distinct_rx_count ?? '—'} />
          <StatCard label="Distinct NDC Count" value={claim.distinct_ndc_count ?? '—'} />
          <StatCard label="Total Qty Dispensed" value={formatQty(claim.total_qty_dispensed)} />
          <StatCard label="Matched NDCs" value={claim.matched_count ?? 0} tone="teal" />
          <StatCard
            label="Unmatched NDCs"
            value={claim.unmatched_count ?? 0}
            tone={claim.unmatched_count > 0 ? 'coral' : 'navy'}
            onClick={claim.unmatched_count > 0 ? goToUnmatched : undefined}
          />
          <StatCard label="Estimated Reimbursement" value={formatCurrency(claim.total_reimbursement)} tone="teal" />
          <StatCard label="Total Full Packages to Order" value={replenishmentTotals.totalRecommendedPacks} tone="warning" />
          <StatCard label="Negative On-Hand NDCs" value={negativeCount} tone={negativeCount > 0 ? 'danger' : 'navy'} />
        </div>
        <p className="text-xs text-gray-400">
          &quot;Claim line count&quot;, &quot;distinct RX count&quot;, and &quot;distinct NDC count&quot; are different measures — see the All Claims and Replenishment
          tabs for the full breakdown. Total packages above is for operational convenience only; the NDC-by-NDC list in Replenishment is the
          authoritative requirement (packages from different NDCs are not interchangeable).
        </p>
        {claim.unmatched_count > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {claim.unmatched_count} NDC{claim.unmatched_count > 1 ? 's' : ''} still need review — every unmatched NDC must be
              added, matched, or explicitly skipped with a reason.
            </span>
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => setBulkAssignOpen(true)}>
                Assign All
              </button>
              <button className="btn-secondary" onClick={goToUnmatched}>
                <Wrench className="h-4 w-4" /> Review Now
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={tab === 'All Claims' ? '' : 'hidden'}>
        <AllClaimsTab
          rows={rawLines}
          onResolveClick={(ndc) => setResolveTarget(lineItems.find((li) => li.ndc === ndc))}
        />
      </div>

      <div className={tab === 'Replenishment by NDC' ? '' : 'hidden'}>
        <ReplenishmentTab
          dailyResults={dailyResults}
          orderPanelRows={orderPanelRows}
          orderingId={orderingId}
          setOrderingId={setOrderingId}
          onResolveClick={(lineItemId) => setResolveTarget(lineItems.find((li) => li.id === lineItemId))}
          onAssignAllClick={() => setBulkAssignOpen(true)}
          unmatchedCount={unmatchedLineItems.length}
          onOrderConfirmed={load}
          claim={claim}
          statusFilter={replenStatusFilter}
          setStatusFilter={setReplenStatusFilter}
          onExport={() =>
            exportReplenishmentReport(replenishment, {
              facilityName: claim.facilities?.name,
              pharmacyName: claim.pharmacies?.name,
              claimDate: claim.claim_date,
            })
          }
        />
      </div>

      <div className={tab === 'Accumulator Changes & Audit' ? '' : 'hidden'}>
        <AuditTab rows={auditLog} />
      </div>

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

      <UnmatchedNdcModal
        open={Boolean(resolveTarget)}
        onClose={() => setResolveTarget(null)}
        lineItem={resolveTarget}
        onResolved={load}
      />

      <BulkAssignNdcModal
        open={bulkAssignOpen}
        onClose={() => setBulkAssignOpen(false)}
        lineItems={unmatchedLineItems}
        onResolved={load}
      />
    </div>
  );
}

function AllClaimsTab({ rows, onResolveClick }) {
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  if (rows.length === 0) {
    return <EmptyState icon={ClipboardList} title="No claim line detail available" message="This batch has no per-RX ledger rows recorded." />;
  }
  const visibleRows = unmatchedOnly ? rows.filter((r) => !r.matched) : rows;
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
      render: (r) =>
        r.matched ? (
          <span className="badge bg-green-50 text-success">Matched</span>
        ) : (
          <button
            className="rounded-md bg-teal-700 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-800"
            title="Look up this NDC and match it to the accumulator"
            onClick={(e) => {
              e.stopPropagation();
              onResolveClick?.(r.ndc);
            }}
          >
            Assign NDC
          </button>
        ),
    },
  ];
  return (
    <div className="space-y-3">
      <label className="flex w-fit items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" checked={unmatchedOnly} onChange={(e) => setUnmatchedOnly(e.target.checked)} />
        Show unmatched only
      </label>
      <DataTable
        columns={columns}
        rows={visibleRows}
        rowKey={(r) => r.id}
        searchPlaceholder="Search RX#, NDC, drug name, prescriber..."
        pageSize={50}
        rowClassName={(r) => (!r.matched ? 'bg-amber-50/40' : '')}
      />
    </div>
  );
}

const STATUS_BADGE = {
  green: <span className="badge bg-green-50 text-success">Balanced</span>,
  red: <span className="badge bg-red-50 text-danger">Needs Order</span>,
  unmatched: <span className="badge bg-amber-50 text-warning">Needs Review</span>,
  skipped: <span className="badge bg-gray-100 text-gray-600">Skipped</span>,
};

const STATUS_ROW_CLASS = {
  green: '',
  red: 'bg-red-50/40',
  unmatched: 'bg-amber-50/40',
  skipped: 'bg-gray-50',
};

function OrderRow({ row, onOrderConfirmed, orderingId, setOrderingId, claim }) {
  const toast = useToast();
  const [qty, setQty] = useState('');
  const [saving, setSaving] = useState(false);
  const isOrdering = orderingId === row.ndc;

  async function handleConfirm() {
    const qtyNum = Number(qty);
    if (!qtyNum || qtyNum <= 0) {
      toast.error('Enter a positive qty ordered.');
      return;
    }
    setSaving(true);
    try {
      const accRow = await findAccumulatorRow(
        claim.facility_id,
        claim.pharmacy_id,
        new Date(claim.claim_date).getMonth() + 1,
        new Date(claim.claim_date).getFullYear(),
        row.ndc
      );
      if (!accRow) throw new Error('Accumulator row not found for this NDC/period.');
      await confirmReplenishmentOrder({ accumulatorId: accRow.id, qtyOrdered: qtyNum });
      toast.success(`Order logged for ${row.ndc} — running balance updated.`);
      setOrderingId(null);
      setQty('');
      onOrderConfirmed();
    } catch (err) {
      toast.error(`Failed to confirm order: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!isOrdering) {
    return (
      <button className="btn-secondary" onClick={() => setOrderingId(row.ndc)}>
        Mark as Ordered
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min="0"
        step="any"
        className="input-field w-24 py-1"
        placeholder="Qty"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        autoFocus
      />
      <button className="btn-primary py-1" disabled={saving} onClick={handleConfirm}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Confirm'}
      </button>
      <button className="text-xs text-gray-400 hover:text-gray-600" onClick={() => setOrderingId(null)}>
        Cancel
      </button>
    </div>
  );
}

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'unmatched', label: 'Needs Review (Unmatched)' },
  { value: 'red', label: 'Needs Order' },
  { value: 'green', label: 'Balanced' },
  { value: 'skipped', label: 'Skipped' },
];

const STATUS_SEARCH_LABEL = {
  green: 'Balanced',
  red: 'Needs Order',
  unmatched: 'Needs Review Unmatched Assign',
  skipped: 'Skipped',
};

function ReplenishmentTab({
  dailyResults,
  orderPanelRows,
  orderingId,
  setOrderingId,
  onResolveClick,
  onAssignAllClick,
  unmatchedCount,
  onOrderConfirmed,
  claim,
  onExport,
  statusFilter,
  setStatusFilter,
}) {
  if (dailyResults.length === 0) {
    return <EmptyState icon={Package} title="No replenishment data is available for this claim batch" message="No NDCs were dispensed in this batch." />;
  }

  const filteredResults = statusFilter === 'all' ? dailyResults : dailyResults.filter((r) => r.status === statusFilter);

  const dailyColumns = [
    { key: 'ndc', label: 'NDC', sortable: true, render: (r) => <span className="font-mono text-xs">{r.ndc}</span> },
    { key: 'productName', label: 'Product Name', sortable: true, render: (r) => r.productName || '—' },
    { key: 'packSize', label: 'Pack Size', sortable: true, accessor: (r) => r.packSize ?? null, render: (r) => r.packSize ?? '—' },
    {
      key: 'startingBalance',
      label: 'Starting Balance (Qty)',
      sortable: true,
      accessor: (r) => (r.startingBalance !== null ? Number(r.startingBalance) : null),
      render: (r) => (r.startingBalance !== null ? formatQty(r.startingBalance) : '—'),
    },
    {
      key: 'qtyDispensedToday',
      label: 'Qty Dispensed Today',
      sortable: true,
      accessor: (r) => Number(r.qtyDispensedToday ?? 0),
      render: (r) => formatQty(r.qtyDispensedToday),
    },
    {
      key: 'newBalance',
      label: 'New Balance (Qty)',
      sortable: true,
      accessor: (r) => (r.newBalance !== null ? Number(r.newBalance) : null),
      render: (r) =>
        r.newBalance !== null ? (
          <span className={Number(r.newBalance) < 0 ? 'font-semibold text-danger' : ''}>{formatQty(r.newBalance)}</span>
        ) : (
          '—'
        ),
    },
    {
      key: 'signed',
      label: 'Packs to Order',
      sortable: true,
      accessor: (r) => (r.signed !== null ? Number(r.signed) : null),
      render: (r) => <span className="font-semibold">{r.signed !== null ? formatQty(r.signed, 4) : '—'}</span>,
    },
    {
      key: 'ppu340b',
      label: '340B PPU',
      sortable: true,
      accessor: (r) => (r.ppu340b !== null && r.ppu340b !== undefined ? Number(r.ppu340b) : null),
      render: (r) => (r.ppu340b !== null && r.ppu340b !== undefined ? formatCurrency(r.ppu340b) : '—'),
    },
    {
      key: 'reimbursementOwed',
      label: 'Reimbursement Owed',
      sortable: true,
      accessor: (r) => (r.reimbursementOwed !== null && r.reimbursementOwed !== undefined ? Number(r.reimbursementOwed) : null),
      render: (r) => (r.reimbursementOwed !== null && r.reimbursementOwed !== undefined ? formatCurrency(r.reimbursementOwed) : '—'),
    },
    { key: 'cin', label: 'CIN', sortable: true, render: (r) => r.cin || '—' },
    { key: 'manufacturer', label: 'Manufacturer', sortable: true, render: (r) => r.manufacturer || '—' },
    { key: 'expDay', label: 'Expiry Date', sortable: true, render: (r) => r.expDay || '—' },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      accessor: (r) => STATUS_SEARCH_LABEL[r.status] ?? r.status,
      render: (r) => (
        <div className="flex items-center gap-2">
          {STATUS_BADGE[r.status]}
          {r.status === 'unmatched' && (
            <button
              className="rounded-md bg-teal-700 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-800"
              onClick={() => onResolveClick(r.lineItemId)}
            >
              Assign NDC
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Daily Results — every NDC in this claim</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input-field w-auto py-1.5"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {STATUS_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {unmatchedCount > 0 && (
              <button className="btn-secondary" onClick={onAssignAllClick}>
                Assign All ({unmatchedCount})
              </button>
            )}
            <button className="btn-secondary" onClick={onExport}>
              <Download className="h-4 w-4" /> Download Standardized Replenishment Report
            </button>
          </div>
        </div>
        {filteredResults.length === 0 ? (
          <EmptyState icon={Package} title="No NDCs match this filter" message="Try a different status filter above." />
        ) : (
          <DataTable
            columns={dailyColumns}
            rows={filteredResults}
            rowKey={(r) => r.lineItemId}
            searchPlaceholder="Search NDC, product name, status..."
            pageSize={50}
            rowClassName={(r) => STATUS_ROW_CLASS[r.status]}
          />
        )}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Replenishment Order Panel — drugs needing an order today</h3>
        {orderPanelRows.length === 0 ? (
          <EmptyState icon={Package} title="Nothing to order" message="No NDCs in this batch need replenishment right now." />
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-auto">
              <table className="w-full min-w-max text-left text-sm">
                <thead className="sticky top-0 bg-surface-alt">
                  <tr>
                    {['Product Name', 'NDC', 'Packs to Order', '340B Price', 'Total Order Cost', 'Action'].map((h) => (
                      <th key={h} className="whitespace-nowrap px-4 py-3 font-semibold text-navy">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderPanelRows.map((r, i) => (
                    <tr key={r.ndc} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                      <td className="whitespace-nowrap px-4 py-2.5">{r.productName}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{r.ndc}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-danger">{formatQty(r.recommendedPacks)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{r.price340b !== null && r.price340b !== undefined ? formatCurrency(r.price340b) : '—'}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-semibold">{r.totalOrderCost !== null ? formatCurrency(r.totalOrderCost) : '—'}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <OrderRow row={r} onOrderConfirmed={onOrderConfirmed} orderingId={orderingId} setOrderingId={setOrderingId} claim={claim} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
