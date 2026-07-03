import { useState } from 'react';
import { Download, Loader2, FileSpreadsheet, Database, TrendingUp, ScrollText } from 'lucide-react';
import { useFacility } from '../context/FacilityContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { fetchAllAccumulatorMonths, fetchMonthlyReimbursementByPharmacy, fetchAuditLog } from '../lib/reportsApi.js';
import { fetchClaimsHistory, fetchClaimDetail } from '../lib/dashboardApi.js';
import { exportAccumulator, exportMonthlyReimbursementReport, exportAuditLog, exportDailyClaims } from '../lib/excelExport.js';
import FacilityPharmacySelector from '../components/common/FacilityPharmacySelector.jsx';
import ScopeLabel from '../components/common/ScopeLabel.jsx';

const now = new Date();

function ReportCard({ icon: Icon, title, description, children }) {
  return (
    <div className="card p-6">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
          <Icon className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold text-navy">{title}</h2>
      </div>
      <p className="mb-4 text-sm text-gray-500">{description}</p>
      {children}
    </div>
  );
}

export default function Reports() {
  const { facilities, selectedFacilityId, selectedPharmacyId, selectedFacility, selectedPharmacy, isAllPharmacies } = useFacility();
  const toast = useToast();

  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [dateFrom, setDateFrom] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(() => now.toISOString().slice(0, 10));
  const [claimId, setClaimId] = useState('');
  const [busy, setBusy] = useState(null);

  const effectiveFacilityId = selectedFacilityId !== 'all' ? selectedFacilityId : facilities[0]?.id;
  const pharmacyLabel = isAllPharmacies ? 'All Pharmacies' : selectedPharmacy?.name;

  async function handleAccumulatorExport() {
    setBusy('accumulator');
    try {
      const months = await fetchAllAccumulatorMonths(effectiveFacilityId, selectedPharmacyId);
      if (months.length === 0) {
        toast.warning('No accumulator data found for this facility/pharmacy.');
        return;
      }
      exportAccumulator(months, { facilityName: selectedFacility?.name, pharmacyLabel });
      toast.success('Accumulator export downloaded.');
    } catch (err) {
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleMonthlyReportExport() {
    setBusy('monthly');
    try {
      const groups = await fetchMonthlyReimbursementByPharmacy(effectiveFacilityId, selectedPharmacyId, month, year);
      if (groups.length === 0) {
        toast.warning('No claims found for that month.');
        return;
      }
      exportMonthlyReimbursementReport(groups, month, year, { facilityName: selectedFacility?.name, pharmacyLabel });
      toast.success('Monthly reimbursement report downloaded.');
    } catch (err) {
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleAuditLogExport() {
    setBusy('audit');
    try {
      const rows = await fetchAuditLog(dateFrom, dateTo, { facilityId: selectedFacilityId, pharmacyId: selectedPharmacyId });
      if (rows.length === 0) {
        toast.warning('No audit log entries found in that date range.');
        return;
      }
      exportAuditLog(rows, dateFrom, dateTo, { facilityName: selectedFacility?.name, pharmacyLabel });
      toast.success('Audit log export downloaded.');
    } catch (err) {
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleDailyClaimsExport() {
    if (!claimId) {
      toast.warning('Select a claim first.');
      return;
    }
    setBusy('daily');
    try {
      const { claim, lineItems } = await fetchClaimDetail(claimId);
      exportDailyClaims(claim, lineItems, {
        pharmacyName: claim.pharmacies?.name ?? 'pharmacy',
        facilityName: claim.facilities?.name ?? 'facility',
      });
      toast.success('Daily claims export downloaded.');
    } catch (err) {
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  const [recentClaims, setRecentClaims] = useState([]);
  const [claimsLoaded, setClaimsLoaded] = useState(false);

  async function loadRecentClaims() {
    if (claimsLoaded) return;
    try {
      const claims = await fetchClaimsHistory({ facilityId: effectiveFacilityId, pharmacyId: selectedPharmacyId, dateFrom: null, dateTo: null });
      setRecentClaims(claims.slice(0, 100));
      setClaimsLoaded(true);
    } catch (err) {
      toast.error(`Failed to load claims list: ${err.message}`);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-navy">Reports</h1>
        <p className="text-sm text-gray-500">Excel exports matching original file formats</p>
      </div>

      <div className="card p-5">
        <FacilityPharmacySelector includeAllFacilities={false} />
      </div>
      <ScopeLabel />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ReportCard icon={FileSpreadsheet} title="Daily Claims Export" description="Pivot summary + raw claim rows for a single day's upload.">
          <select className="input-field mb-3" value={claimId} onFocus={loadRecentClaims} onChange={(e) => setClaimId(e.target.value)}>
            <option value="">Select a claim...</option>
            {recentClaims.map((c) => (
              <option key={c.id} value={c.id}>
                {c.claim_date} — {c.pharmacyName}
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleDailyClaimsExport} disabled={busy === 'daily'}>
            {busy === 'daily' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export
          </button>
        </ReportCard>

        <ReportCard icon={Database} title="Accumulator Export" description="One sheet per month on record — includes a Pharmacy column when viewing all pharmacies.">
          <button className="btn-primary" onClick={handleAccumulatorExport} disabled={busy === 'accumulator'}>
            {busy === 'accumulator' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export
          </button>
        </ReportCard>

        <ReportCard icon={TrendingUp} title="Monthly Reimbursement Report" description="Summary by pharmacy: NDC, Drug Name, Total Qty, Total Packs, PPU, Total Reimbursement.">
          <div className="mb-3 flex gap-3">
            <select className="input-field" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }).map((_, i) => (
                <option key={i} value={i + 1}>
                  {new Date(2000, i, 1).toLocaleString('default', { month: 'long' })}
                </option>
              ))}
            </select>
            <input type="number" className="input-field w-28" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </div>
          <button className="btn-primary" onClick={handleMonthlyReportExport} disabled={busy === 'monthly'}>
            {busy === 'monthly' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export
          </button>
        </ReportCard>

        <ReportCard icon={ScrollText} title="Audit Log Export" description="Full immutable accumulator audit trail for a date range (HRSA-ready), with facility and pharmacy on every row.">
          <div className="mb-3 flex gap-3">
            <div>
              <label className="label-text">From</label>
              <input type="date" className="input-field" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div>
              <label className="label-text">To</label>
              <input type="date" className="input-field" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>
          <button className="btn-primary" onClick={handleAuditLogExport} disabled={busy === 'audit'}>
            {busy === 'audit' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export
          </button>
        </ReportCard>
      </div>
    </div>
  );
}
