import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, HeartPulse } from 'lucide-react';
import { useFacility } from '../context/FacilityContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { fetchPeriods, fetchAccumulatorRows } from '../lib/accumulatorApi.js';
import { exportDataHealthReport } from '../lib/excelExport.js';
import { formatQty } from '../lib/calculations.js';
import DataTable from '../components/common/DataTable.jsx';
import EmptyState from '../components/common/EmptyState.jsx';
import { SkeletonTable } from '../components/common/Skeleton.jsx';
import FacilityPharmacySelector from '../components/common/FacilityPharmacySelector.jsx';
import ScopeLabel from '../components/common/ScopeLabel.jsx';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STALE_DAYS = 30;

const BASE_COLUMNS = [
  { key: 'ndc', label: 'NDC', sortable: true, render: (r) => <span className="font-mono text-xs">{r.ndc}</span> },
  { key: 'product_name', label: 'Product Name', sortable: true },
  { key: 'pharmacyName', label: 'Pharmacy', sortable: true },
];

/**
 * Data-integrity checks over the currently-selected facility/pharmacy's
 * latest accumulator period — catches the kind of bad-data issues (missing
 * pack size, missing PPU, rows nobody's touched in a month) that silently
 * corrupt Packs to Order / reimbursement math before they cause a bad
 * order, instead of finding them after the fact.
 */
function computeIssues(rows) {
  const now = Date.now();
  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;

  const missingPackSize = rows.filter((r) => r.pack_size === null || Number(r.pack_size) === 0);
  const missingPpu = rows.filter((r) => r.ppu_340b === null || Number(r.ppu_340b) === 0);
  const missingPrice = rows.filter((r) => r.price_340b === null || Number(r.price_340b) === 0);
  const stale = rows.filter((r) => r.updated_at && now - new Date(r.updated_at).getTime() > staleMs);
  const missingMetadata = rows.filter((r) => !r.cin || !r.manufacturer);

  return { missingPackSize, missingPpu, missingPrice, stale, missingMetadata };
}

function IssueSection({ title, description, severity, rows, columns, emptyLabel }) {
  const toneClass = severity === 'high' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50';
  const countClass = severity === 'high' ? 'text-danger' : 'text-warning';

  return (
    <section className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-navy">{title}</h2>
          <p className="text-xs text-gray-500">{description}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-bold ${countClass} ${rows.length > 0 ? toneClass : 'bg-green-50 text-success'}`}>
          {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">{emptyLabel}</p>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} pageSize={10} searchPlaceholder="Search NDC or product name..." />
      )}
    </section>
  );
}

export default function DataHealth() {
  const { selectedFacilityId, selectedPharmacyId, selectedFacility, selectedPharmacy, isAllPharmacies } = useFacility();
  const toast = useToast();

  const [periods, setPeriods] = useState([]);
  const [period, setPeriod] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const facilitySelected = selectedFacilityId !== 'all';

  useEffect(() => {
    async function loadPeriods() {
      if (!facilitySelected) return;
      const p = await fetchPeriods(selectedFacilityId, selectedPharmacyId);
      setPeriods(p);
      setPeriod(p[0] ?? null);
    }
    loadPeriods();
  }, [facilitySelected, selectedFacilityId, selectedPharmacyId]);

  useEffect(() => {
    async function loadRows() {
      if (!facilitySelected || !period) {
        setRows([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const data = await fetchAccumulatorRows(selectedFacilityId, selectedPharmacyId, period.month, period.year);
        setRows(data);
      } catch (err) {
        toast.error(`Failed to load accumulator: ${err.message}`);
      } finally {
        setLoading(false);
      }
    }
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilitySelected, selectedFacilityId, selectedPharmacyId, period]);

  const issues = useMemo(() => computeIssues(rows), [rows]);
  const totalIssues =
    issues.missingPackSize.length + issues.missingPpu.length + issues.missingPrice.length + issues.stale.length + issues.missingMetadata.length;

  const columns = isAllPharmacies ? BASE_COLUMNS : BASE_COLUMNS.filter((c) => c.key !== 'pharmacyName');

  const packSizeColumns = [
    ...columns,
    { key: 'pack_size', label: 'Pack Size', sortable: true, render: (r) => (r.pack_size ? formatQty(r.pack_size) : <span className="text-danger">—</span>) },
  ];
  const ppuColumns = [
    ...columns,
    { key: 'ppu_340b', label: '340B PPU', sortable: true, render: (r) => (r.ppu_340b ? formatQty(r.ppu_340b, 4) : <span className="text-danger">—</span>) },
  ];
  const priceColumns = [
    ...columns,
    { key: 'price_340b', label: '340B Price', sortable: true, render: (r) => (r.price_340b ? formatQty(r.price_340b, 4) : <span className="text-warning">—</span>) },
  ];
  const staleColumns = [
    ...columns,
    {
      key: 'updated_at',
      label: 'Last Updated',
      sortable: true,
      render: (r) => (r.updated_at ? new Date(r.updated_at).toLocaleDateString() : '—'),
    },
  ];

  const metadataColumns = [
    ...columns,
    { key: 'cin', label: 'CIN', sortable: true, render: (r) => r.cin || <span className="text-warning">Missing</span> },
    { key: 'manufacturer', label: 'Manufacturer', sortable: true, render: (r) => r.manufacturer || <span className="text-warning">Missing</span> },
  ];

  if (!facilitySelected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-navy">
            <HeartPulse className="h-5 w-5" /> Data Health
          </h1>
          <p className="text-sm text-gray-500">Catch bad or incomplete accumulator data before it causes a bad order.</p>
        </div>
        <div className="card p-5">
          <FacilityPharmacySelector includeAllFacilities={false} />
        </div>
        <EmptyState title="Select a facility" message="Choose a facility above to check its accumulator data." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-navy">
            <HeartPulse className="h-5 w-5" /> Data Health
          </h1>
          <p className="text-sm text-gray-500">Catch bad or incomplete accumulator data before it causes a bad order.</p>
        </div>
        <button
          className="btn-secondary"
          disabled={rows.length === 0}
          onClick={() =>
            exportDataHealthReport(issues, {
              facilityName: selectedFacility?.name,
              pharmacyLabel: isAllPharmacies ? 'All Pharmacies' : selectedPharmacy?.name,
              rangeLabel: period ? `${MONTH_NAMES[period.month - 1]} ${period.year}` : '',
            })
          }
        >
          <Download className="h-4 w-4" /> Export Report
        </button>
      </div>

      <div className="card space-y-4 p-5">
        <FacilityPharmacySelector includeAllFacilities={false} />
        {period && (
          <div>
            <label className="label-text">Period</label>
            <select
              className="input-field w-auto"
              value={`${period.year}-${period.month}`}
              onChange={(e) => {
                const [y, m] = e.target.value.split('-').map(Number);
                setPeriod({ month: m, year: y });
              }}
            >
              {periods.map((p) => (
                <option key={`${p.year}-${p.month}`} value={`${p.year}-${p.month}`}>
                  {MONTH_NAMES[p.month - 1]} {p.year}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <ScopeLabel period={period ? `${MONTH_NAMES[period.month - 1]} ${period.year}` : undefined} />

      {loading ? (
        <SkeletonTable rows={6} cols={4} />
      ) : !period ? (
        <EmptyState title="No accumulator data yet" message="Start this pharmacy's accumulator to check its data health." />
      ) : (
        <>
          <div className={`card flex items-center gap-3 p-4 ${totalIssues > 0 ? 'border-amber-200 bg-amber-50' : 'border-green-200 bg-green-50'}`}>
            {totalIssues > 0 ? <AlertTriangle className="h-5 w-5 text-warning" /> : <HeartPulse className="h-5 w-5 text-success" />}
            <p className="text-sm font-medium text-navy">
              {totalIssues === 0
                ? `All ${rows.length} rows in this period look clean.`
                : `${totalIssues} issue${totalIssues > 1 ? 's' : ''} found across ${rows.length} rows this period.`}
            </p>
          </div>

          <IssueSection
            title="Missing or zero Pack Size"
            description="Packs to Order and Packs on Hand can't be computed without this — the row is silently skipped from replenishment math."
            severity="high"
            rows={issues.missingPackSize}
            columns={packSizeColumns}
            emptyLabel="Every row has a Pack Size."
          />
          <IssueSection
            title="Missing or zero 340B PPU"
            description="Reimbursement Owed and Cost on Hand can't be priced out without this."
            severity="high"
            rows={issues.missingPpu}
            columns={ppuColumns}
            emptyLabel="Every row has a 340B PPU."
          />
          <IssueSection
            title="Missing 340B Price"
            description="Used for order-cost estimates on the Replenishment Order Panel."
            severity="medium"
            rows={issues.missingPrice}
            columns={priceColumns}
            emptyLabel="Every row has a 340B Price."
          />
          <IssueSection
            title={`Not updated in ${STALE_DAYS}+ days`}
            description="No claim, order, or edit has touched this row recently — worth a manual spot-check that it still reflects reality."
            severity="medium"
            rows={issues.stale}
            columns={staleColumns}
            emptyLabel="Every row has moved recently."
          />
          <IssueSection
            title="Missing CIN or Manufacturer"
            description="Metadata completeness only — doesn't affect any calculation, but worth filling in for reporting."
            severity="low"
            rows={issues.missingMetadata}
            columns={metadataColumns}
            emptyLabel="Every row has both fields filled in."
          />
        </>
      )}
    </div>
  );
}
