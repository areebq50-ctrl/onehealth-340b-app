import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { DollarSign, FileText, AlertTriangle, Clock, Inbox } from 'lucide-react';
import { useFacility } from '../context/FacilityContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { fetchClaimsHistory, fetchDashboardSummary, fetchDailyTrend } from '../lib/dashboardApi.js';
import { formatCurrency, formatQty } from '../lib/calculations.js';
import DataTable from '../components/common/DataTable.jsx';
import FacilityPharmacySelector from '../components/common/FacilityPharmacySelector.jsx';
import ScopeLabel from '../components/common/ScopeLabel.jsx';
import { SkeletonCards, SkeletonTable } from '../components/common/Skeleton.jsx';
import EmptyState from '../components/common/EmptyState.jsx';

const now = new Date();

function SummaryCard({ icon: Icon, label, value, tone = 'teal' }) {
  const tones = {
    teal: 'bg-teal-50 text-teal-700',
    coral: 'bg-coral-50 text-coral-700',
    amber: 'bg-amber-50 text-warning',
    navy: 'bg-gray-100 text-navy',
  };
  return (
    <div className="card p-5">
      <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-lg ${tones[tone]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-navy">{value}</p>
    </div>
  );
}

export default function Dashboard() {
  const { selectedFacilityId, selectedPharmacyId, selectedPharmacy, isAllPharmacies } = useFacility();
  const toast = useToast();
  const navigate = useNavigate();

  const [dateFrom, setDateFrom] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(() => now.toISOString().slice(0, 10));

  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [claims, setClaims] = useState([]);
  const [trend, setTrend] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [summaryData, claimsData, trendData] = await Promise.all([
          fetchDashboardSummary({
            facilityId: selectedFacilityId,
            pharmacyId: selectedPharmacyId,
            month: now.getMonth() + 1,
            year: now.getFullYear(),
          }),
          fetchClaimsHistory({ facilityId: selectedFacilityId, pharmacyId: selectedPharmacyId, dateFrom, dateTo }),
          fetchDailyTrend({ facilityId: selectedFacilityId, pharmacyId: selectedPharmacyId, month: now.getMonth() + 1, year: now.getFullYear() }),
        ]);
        if (cancelled) return;
        setSummary(summaryData);
        setClaims(claimsData);
        setTrend(trendData);
      } catch (err) {
        if (!cancelled) toast.error(`Failed to load dashboard: ${err.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFacilityId, selectedPharmacyId, dateFrom, dateTo]);

  const columns = useMemo(
    () => [
      { key: 'claim_date', label: 'Date', sortable: true, accessor: (r) => r.claim_date },
      ...(isAllPharmacies ? [{ key: 'pharmacyName', label: 'Pharmacy', sortable: true }] : []),
      { key: 'facilityName', label: 'Facility', sortable: true },
      { key: 'ndcCount', label: 'NDCs Processed', sortable: true },
      { key: 'totalQty', label: 'Total Qty Dispensed', sortable: true, accessor: (r) => r.totalQty.toNumber(), render: (r) => formatQty(r.totalQty) },
      {
        key: 'total_reimbursement',
        label: 'Total Reimbursement',
        sortable: true,
        render: (r) => <span className="font-semibold">{formatCurrency(r.total_reimbursement)}</span>,
      },
      { key: 'uploadedByEmail', label: 'Uploaded By', sortable: true },
    ],
    [isAllPharmacies]
  );

  const emptyMessage = isAllPharmacies
    ? 'No claims found for this facility in this range.'
    : `No claims found for ${selectedPharmacy?.name ?? 'this pharmacy'} in this period.`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-navy">Dashboard</h1>
        <p className="text-sm text-gray-500">340B claims processing overview</p>
      </div>

      <div className="card p-5">
        <FacilityPharmacySelector />
      </div>
      <ScopeLabel period={`${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}`} />

      {loading && !summary ? (
        <SkeletonCards />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            icon={DollarSign}
            label={isAllPharmacies ? 'Reimbursement This Month (All Pharmacies)' : `Reimbursement This Month — ${selectedPharmacy?.name ?? ''}`}
            value={formatCurrency(summary?.totalReimbursement)}
            tone="teal"
          />
          <SummaryCard icon={FileText} label="Claims Processed" value={summary?.totalClaims ?? 0} tone="navy" />
          <SummaryCard icon={AlertTriangle} label="Unmatched NDCs" value={summary?.unmatchedCount ?? 0} tone="coral" />
          <SummaryCard icon={Clock} label="Expiring Within 60 Days" value={summary?.expiringCount ?? 0} tone="amber" />
        </div>
      )}

      <div className="card p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Monthly Reimbursement Trend {isAllPharmacies ? '(All Pharmacies)' : `— ${selectedPharmacy?.name ?? ''}`}
        </h2>
        {trend.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No claims processed yet this month.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E9EB" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v) => formatCurrency(v)} labelFormatter={(d) => `Day ${d}`} />
              <Bar dataKey="total" fill="#0E7C7B" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="label-text">From</label>
          <input type="date" className="input-field" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label className="label-text">To</label>
          <input type="date" className="input-field" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <SkeletonTable />
      ) : claims.length === 0 ? (
        <EmptyState icon={Inbox} title="No claims in this range" message={emptyMessage} />
      ) : (
        <DataTable
          columns={columns}
          rows={claims}
          rowKey={(r) => r.id}
          searchPlaceholder="Search claims..."
          onRowClick={(r) => navigate(`/claims/${r.id}`)}
          rowClassName={(r) => (r.unmatchedCount > 0 ? 'border-l-2 border-l-warning' : '')}
          emptyTitle="No claims"
          emptyMessage={emptyMessage}
        />
      )}
    </div>
  );
}
