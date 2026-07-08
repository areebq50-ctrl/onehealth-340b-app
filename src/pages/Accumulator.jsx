import { useEffect, useMemo, useState } from 'react';
import { Download, Plus, Upload, FileText, CalendarRange, CalendarDays, Loader2, Lock, Pencil, Trash2, AlertTriangle, ScrollText } from 'lucide-react';
import { useFacility } from '../context/FacilityContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import {
  fetchPeriods,
  fetchAccumulatorRows,
  editAccumulatorRow,
  addAccumulatorRow,
  rolloverMonth,
  importAccumulatorRows,
  deleteAccumulatorRow,
  deleteAccumulatorPeriod,
  countClaimsForPeriod,
  receiveInvoiceBulk,
  fetchPeriodAuditHistory,
} from '../lib/accumulatorApi.js';
import { readAccumulatorWorkbook, parseAccumulatorSheet } from '../parsers/accumulatorXlsxParser.js';
import { parseCardinalHealthInvoice } from '../parsers/cardinalHealthInvoiceParser.js';
import { exportAccumulator } from '../lib/excelExport.js';
import { formatCurrency, formatQty, packsOnHand, costOnHand340b, Decimal } from '../lib/calculations.js';
import { buildDailySnapshot } from '../lib/ledger.js';
import { normalizeNdc } from '../lib/ndc.js';
import { getExpiryTone, EXPIRY_TONE_CLASSES } from '../components/accumulator/expiry.js';
import NdcLedgerModal from '../components/accumulator/NdcLedgerModal.jsx';
import DataTable from '../components/common/DataTable.jsx';
import Modal from '../components/common/Modal.jsx';
import { SkeletonTable } from '../components/common/Skeleton.jsx';
import EmptyState from '../components/common/EmptyState.jsx';
import FacilityPharmacySelector from '../components/common/FacilityPharmacySelector.jsx';
import ScopeLabel from '../components/common/ScopeLabel.jsx';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ACCUMULATOR_FILTERS_KEY = 'onehealth340b.accumulatorFilters';

function loadStoredFilters() {
  try {
    const raw = localStorage.getItem(ACCUMULATOR_FILTERS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const DEFAULT_FILTERS = { expiry: 'all', manufacturer: 'all', negativeOnly: false };

function EditRowForm({ row, onSave, onDelete, onCancel, saving }) {
  const [form, setForm] = useState({
    product_name: row.product_name ?? '',
    pack_size: row.pack_size ?? '',
    price_340b: row.price_340b ?? '',
    ppu_340b: row.ppu_340b ?? '',
    exp_day: row.exp_day ?? '',
    qty_on_hand: row.qty_on_hand ?? '',
    cin: row.cin ?? '',
    manufacturer: row.manufacturer ?? '',
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label-text">Product Name</label>
          <input className="input-field" value={form.product_name} onChange={(e) => setForm((f) => ({ ...f, product_name: e.target.value }))} />
        </div>
        <div>
          <label className="label-text">Pack Size</label>
          <input className="input-field" type="number" value={form.pack_size} onChange={(e) => setForm((f) => ({ ...f, pack_size: e.target.value }))} />
        </div>
        <div>
          <label className="label-text">Qty on Hand</label>
          <input className="input-field" type="number" value={form.qty_on_hand} onChange={(e) => setForm((f) => ({ ...f, qty_on_hand: e.target.value }))} />
        </div>
        <div>
          <label className="label-text">340B Price</label>
          <input className="input-field" type="number" step="0.0001" value={form.price_340b} onChange={(e) => setForm((f) => ({ ...f, price_340b: e.target.value }))} />
        </div>
        <div>
          <label className="label-text">340B PPU</label>
          <input className="input-field" type="number" step="0.0001" value={form.ppu_340b} onChange={(e) => setForm((f) => ({ ...f, ppu_340b: e.target.value }))} />
        </div>
        <div>
          <label className="label-text">Exp Day</label>
          <input className="input-field" type="date" value={form.exp_day ?? ''} onChange={(e) => setForm((f) => ({ ...f, exp_day: e.target.value }))} />
        </div>
        <div>
          <label className="label-text">CIN</label>
          <input className="input-field" value={form.cin ?? ''} onChange={(e) => setForm((f) => ({ ...f, cin: e.target.value }))} />
        </div>
        <div className="col-span-2">
          <label className="label-text">Manufacturer</label>
          <input className="input-field" value={form.manufacturer ?? ''} onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))} />
        </div>
      </div>
      <div className="flex items-center justify-between pt-2">
        <button className="btn-danger" onClick={onDelete} disabled={saving}>
          <Trash2 className="h-4 w-4" /> Delete Row
        </button>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Accumulator() {
  const { selectedFacilityId, selectedPharmacyId, selectedFacility, selectedPharmacy, isAllPharmacies } = useFacility();
  const { isAdmin } = useAuth();
  const toast = useToast();

  const [periods, setPeriods] = useState([]);
  const [period, setPeriod] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const [editingRow, setEditingRow] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [ledgerRow, setLedgerRow] = useState(null);
  const [view, setView] = useState('master'); // 'master' | 'daily'
  const [dailyEntries, setDailyEntries] = useState([]);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rolloverOpen, setRolloverOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [deletingPeriod, setDeletingPeriod] = useState(false);

  const [filters, setFilters] = useState(() => ({ ...DEFAULT_FILTERS, ...loadStoredFilters() }));

  useEffect(() => {
    localStorage.setItem(ACCUMULATOR_FILTERS_KEY, JSON.stringify(filters));
  }, [filters]);

  const facilitySelected = selectedFacilityId !== 'all';
  const canWrite = isAdmin && facilitySelected && !isAllPharmacies;

  async function loadPeriods() {
    if (!facilitySelected) return;
    const p = await fetchPeriods(selectedFacilityId, selectedPharmacyId);
    setPeriods(p);
    setPeriod(p[0] ?? null);
  }

  useEffect(() => {
    loadPeriods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFacilityId, selectedPharmacyId]);

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
  }, [selectedFacilityId, selectedPharmacyId, period]);

  // A new facility/pharmacy/period invalidates any previously-picked date —
  // let the default-date effect below re-derive a sensible one for the new
  // context instead of carrying forward a date from a different period.
  useEffect(() => {
    setSelectedDate(null);
  }, [selectedFacilityId, selectedPharmacyId, period]);

  useEffect(() => {
    async function loadDaily() {
      if (view !== 'daily' || !facilitySelected || !period || isAllPharmacies) {
        setDailyEntries([]);
        return;
      }
      setLoadingDaily(true);
      try {
        const data = await fetchPeriodAuditHistory(selectedFacilityId, selectedPharmacyId, period.month, period.year);
        setDailyEntries(data);
      } catch (err) {
        toast.error(`Failed to load daily ledger: ${err.message}`);
      } finally {
        setLoadingDaily(false);
      }
    }
    loadDaily();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedFacilityId, selectedPharmacyId, period, isAllPharmacies]);

  const entriesByNdc = useMemo(() => {
    const map = new Map();
    for (const e of dailyEntries) {
      if (!map.has(e.ndc)) map.set(e.ndc, []);
      map.get(e.ndc).push(e);
    }
    return map;
  }, [dailyEntries]);

  const activityDates = useMemo(
    () => Array.from(new Set(dailyEntries.map((e) => new Date(e.timestamp).toISOString().slice(0, 10)))).sort(),
    [dailyEntries]
  );

  // Default the "as of" date once daily data has loaded: today, if today
  // falls inside the selected period, otherwise the most recent day that
  // actually had activity, otherwise just the 1st of the period.
  useEffect(() => {
    if (view !== 'daily' || selectedDate || loadingDaily || !period) return;
    const today = new Date();
    const todayInPeriod = today.getFullYear() === period.year && today.getMonth() + 1 === period.month;
    const todayStr = today.toISOString().slice(0, 10);
    const fallback = activityDates[activityDates.length - 1] ?? `${period.year}-${String(period.month).padStart(2, '0')}-01`;
    setSelectedDate(todayInPeriod ? todayStr : fallback);
  }, [view, selectedDate, loadingDaily, activityDates, period]);

  const isLatestPeriod = periods.length > 0 && period && periods[0].month === period.month && periods[0].year === period.year;

  const columns = useMemo(
    () => [
      {
        key: 'history',
        label: 'History',
        render: (r) => (
          <button className="btn-secondary px-2 py-1" title="View running ledger for this NDC" onClick={() => setLedgerRow(r)}>
            <ScrollText className="h-3.5 w-3.5" />
          </button>
        ),
      },
      { key: 'ndc', label: 'NDC', sortable: true, render: (r) => <span className="font-mono text-xs">{r.ndc}</span> },
      { key: 'product_name', label: 'Product Name', sortable: true },
      ...(isAllPharmacies ? [{ key: 'pharmacyName', label: 'Pharmacy', sortable: true }] : []),
      { key: 'pack_size', label: 'Pack Size', sortable: true, accessor: (r) => Number(r.pack_size ?? 0) },
      { key: 'qty_on_hand', label: 'Qty on Hand', sortable: true, accessor: (r) => Number(r.qty_on_hand ?? 0), render: (r) => formatQty(r.qty_on_hand) },
      { key: 'packs_on_hand', label: 'Packs on Hand', sortable: true, accessor: (r) => Number(r.packs_on_hand ?? 0), render: (r) => (r.packs_on_hand !== null ? formatQty(r.packs_on_hand) : '—') },
      {
        key: 'exp_day',
        label: 'Exp Day',
        sortable: true,
        render: (r) => {
          const { tone, label } = getExpiryTone(r.exp_day);
          return <span className={`badge ${EXPIRY_TONE_CLASSES[tone]}`}>{label}</span>;
        },
      },
      { key: 'price_340b', label: '340B Price', sortable: true, accessor: (r) => Number(r.price_340b ?? 0), render: (r) => formatCurrency(r.price_340b) },
      { key: 'ppu_340b', label: '340B PPU', sortable: true, accessor: (r) => Number(r.ppu_340b ?? 0), render: (r) => formatCurrency(r.ppu_340b) },
      { key: 'cost_on_hand_340b', label: '340B Cost on Hand', sortable: true, accessor: (r) => Number(r.cost_on_hand_340b ?? 0), render: (r) => formatCurrency(r.cost_on_hand_340b) },
      { key: 'cin', label: 'CIN', sortable: true },
      { key: 'manufacturer', label: 'Manufacturer', sortable: true },
      ...(canWrite && isLatestPeriod
        ? [
            {
              key: 'actions',
              label: 'Actions',
              render: (r) => (
                <button className="btn-secondary px-2 py-1" onClick={() => setEditingRow(r)}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              ),
            },
          ]
        : []),
    ],
    [canWrite, isLatestPeriod, isAllPharmacies]
  );

  const manufacturers = useMemo(
    () => Array.from(new Set(rows.map((r) => r.manufacturer).filter(Boolean))).sort(),
    [rows]
  );

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (filters.negativeOnly && !(Number(r.qty_on_hand) < 0)) return false;
      if (filters.manufacturer !== 'all' && r.manufacturer !== filters.manufacturer) return false;
      if (filters.expiry !== 'all') {
        const { daysUntil } = getExpiryTone(r.exp_day);
        if (daysUntil === undefined || daysUntil > Number(filters.expiry)) return false;
      }
      return true;
    });
  }, [rows, filters]);

  // Same expiry/manufacturer filters as the master view, but negativeOnly is
  // applied after the snapshot below (against that day's Ending Balance,
  // not the row's current qty_on_hand) since the whole point of this view is
  // seeing what the balance was on a specific day, not today.
  const dailyBaseRows = useMemo(() => {
    return rows.filter((r) => {
      if (filters.manufacturer !== 'all' && r.manufacturer !== filters.manufacturer) return false;
      if (filters.expiry !== 'all') {
        const { daysUntil } = getExpiryTone(r.exp_day);
        if (daysUntil === undefined || daysUntil > Number(filters.expiry)) return false;
      }
      return true;
    });
  }, [rows, filters]);

  const dailyRows = useMemo(() => {
    if (!selectedDate) return [];
    const snapshot = buildDailySnapshot(dailyBaseRows, entriesByNdc, selectedDate);
    return filters.negativeOnly ? snapshot.filter((r) => Number(r.endingBalance) < 0) : snapshot;
  }, [dailyBaseRows, entriesByNdc, selectedDate, filters.negativeOnly]);

  const dailyColumns = useMemo(
    () => [
      { key: 'ndc', label: 'NDC', sortable: true, render: (r) => <span className="font-mono text-xs">{r.ndc}</span> },
      { key: 'product_name', label: 'Product Name', sortable: true },
      ...(isAllPharmacies ? [{ key: 'pharmacyName', label: 'Pharmacy', sortable: true }] : []),
      { key: 'pack_size', label: 'Pack Size', sortable: true, accessor: (r) => Number(r.pack_size ?? 0) },
      {
        key: 'startingBalance',
        label: 'Starting Balance',
        sortable: true,
        accessor: (r) => Number(r.startingBalance ?? 0),
        render: (r) => formatQty(r.startingBalance),
      },
      {
        key: 'dispensed',
        label: 'Dispensed',
        sortable: true,
        accessor: (r) => Number(r.dispensed ?? 0),
        render: (r) => (r.dispensed > 0 ? <span className="text-danger">-{formatQty(r.dispensed)}</span> : '—'),
      },
      {
        key: 'ordered',
        label: 'Order Received',
        sortable: true,
        accessor: (r) => Number(r.ordered ?? 0),
        render: (r) => (r.ordered > 0 ? <span className="text-success">+{formatQty(r.ordered)}</span> : '—'),
      },
      {
        key: 'endingBalance',
        label: 'Ending Balance',
        sortable: true,
        accessor: (r) => Number(r.endingBalance ?? 0),
        render: (r) => <span className={Number(r.endingBalance) < 0 ? 'font-semibold text-danger' : 'font-semibold'}>{formatQty(r.endingBalance)}</span>,
      },
      {
        key: 'packsToOrder',
        label: 'Packs to Order',
        sortable: true,
        accessor: (r) => (r.packsToOrder?.flagged ? 0 : Number(r.packsToOrder?.value ?? 0)),
        render: (r) => (r.packsToOrder?.flagged ? '—' : formatQty(r.packsToOrder.value, 4)),
      },
      {
        key: 'exp_day',
        label: 'Exp Day',
        sortable: true,
        render: (r) => {
          const { tone, label } = getExpiryTone(r.exp_day);
          return <span className={`badge ${EXPIRY_TONE_CLASSES[tone]}`}>{label}</span>;
        },
      },
      { key: 'manufacturer', label: 'Manufacturer', sortable: true },
      {
        key: 'history',
        label: 'Full History',
        render: (r) => (
          <button className="btn-secondary px-2 py-1" title="View this NDC's full running ledger for the period" onClick={() => setLedgerRow(r)}>
            <ScrollText className="h-3.5 w-3.5" />
          </button>
        ),
      },
    ],
    [isAllPharmacies]
  );

  async function refreshRows() {
    const data = await fetchAccumulatorRows(selectedFacilityId, selectedPharmacyId, period.month, period.year);
    setRows(data);
  }

  async function handleSaveEdit(form) {
    setSavingEdit(true);
    try {
      await editAccumulatorRow({ id: editingRow.id, ...form });
      toast.success('Accumulator row updated.');
      setEditingRow(null);
      await refreshRows();
    } catch (err) {
      toast.error(`Update failed: ${err.message}`);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeleteRow() {
    if (!window.confirm(`Delete accumulator row for NDC ${editingRow.ndc}? This is audited and cannot be undone.`)) return;
    setSavingEdit(true);
    try {
      await deleteAccumulatorRow(editingRow.id);
      toast.success('Accumulator row deleted.');
      setEditingRow(null);
      await refreshRows();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeletePeriod() {
    const claimCount = await countClaimsForPeriod(selectedFacilityId, selectedPharmacyId, period.month, period.year);
    const claimWarning =
      claimCount > 0
        ? ` ${claimCount} claim batch${claimCount > 1 ? 'es have' : ' has'} already been processed against this period — deleting the ` +
          `accumulator will NOT reverse those claims or their reimbursement, it only removes the current on-hand rows.`
        : '';
    if (
      !window.confirm(
        `Delete ALL ${rows.length} accumulator rows for ${selectedPharmacy?.name} — ${MONTH_NAMES[period.month - 1]} ${period.year}? ` +
          `This cannot be undone.${claimWarning}`
      )
    )
      return;
    setDeletingPeriod(true);
    try {
      const count = await deleteAccumulatorPeriod({
        facilityId: selectedFacilityId,
        pharmacyId: selectedPharmacyId,
        month: period.month,
        year: period.year,
      });
      toast.success(`Deleted ${count} accumulator rows for this period.`);
      await loadPeriods();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setDeletingPeriod(false);
    }
  }

  if (!facilitySelected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-navy">Accumulator</h1>
          <p className="text-sm text-gray-500">Master drug inventory by facility and pharmacy</p>
        </div>
        <div className="card p-5">
          <FacilityPharmacySelector includeAllFacilities={false} />
        </div>
        <EmptyState title="Select a facility" message="Choose a facility above to view its accumulator." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-navy">Accumulator</h1>
          <p className="text-sm text-gray-500">Master drug inventory by facility and pharmacy</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-secondary"
            onClick={() =>
              rows.length > 0 &&
              exportAccumulator([{ month: period.month, year: period.year, rows }], {
                facilityName: selectedFacility?.name,
                pharmacyLabel: isAllPharmacies ? 'All Pharmacies' : selectedPharmacy?.name,
              })
            }
          >
            <Download className="h-4 w-4" /> Export
          </button>
          {isAdmin && (
            <>
              <button className="btn-secondary" onClick={() => setImportOpen(true)} disabled={!canWrite} title={!canWrite ? 'Select a specific pharmacy to import' : ''}>
                <Upload className="h-4 w-4" /> Import Excel
              </button>
              <button
                className="btn-secondary"
                onClick={() => setReceiveOpen(true)}
                disabled={!canWrite || !isLatestPeriod || rows.length === 0}
                title={!isLatestPeriod ? 'Start or select the current period first' : ''}
              >
                <FileText className="h-4 w-4" /> Upload Invoice
              </button>
              <button className="btn-secondary" onClick={() => setRolloverOpen(true)} disabled={!canWrite} title={!canWrite ? 'Select a specific pharmacy to roll over' : ''}>
                <CalendarRange className="h-4 w-4" /> Start New Month
              </button>
              <button className="btn-primary" onClick={() => setAddOpen(true)} disabled={!canWrite || (!isLatestPeriod && periods.length > 0)}>
                <Plus className="h-4 w-4" /> Add NDC
              </button>
              <button
                className="btn-secondary text-danger"
                onClick={handleDeletePeriod}
                disabled={!canWrite || !isLatestPeriod || rows.length === 0 || deletingPeriod}
                title={!isLatestPeriod ? 'Only the latest (open) period can be deleted' : ''}
              >
                {deletingPeriod ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete This Period
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card space-y-4 p-5">
        <FacilityPharmacySelector includeAllFacilities={false} />
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label-text">Period</label>
            <select
              className="input-field"
              value={period ? `${period.year}-${period.month}` : ''}
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
          {period && (
            <div>
              <label className="label-text">View</label>
              <div className="flex rounded-lg border border-gray-200 p-0.5">
                <button
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    view === 'master' ? 'bg-navy text-white' : 'text-gray-500 hover:text-navy'
                  }`}
                  onClick={() => setView('master')}
                >
                  Master
                </button>
                <button
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    view === 'daily' ? 'bg-navy text-white' : 'text-gray-500 hover:text-navy'
                  } ${isAllPharmacies ? 'cursor-not-allowed opacity-50' : ''}`}
                  onClick={() => !isAllPharmacies && setView('daily')}
                  disabled={isAllPharmacies}
                  title={isAllPharmacies ? 'Select a specific pharmacy to view the Daily Ledger' : 'One row per NDC, showing that day’s Starting/Dispensed/Order Received/Ending Balance'}
                >
                  <CalendarDays className="h-3.5 w-3.5" /> Daily Ledger
                </button>
              </div>
            </div>
          )}
          {!isLatestPeriod && period && (
            <span className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
              <Lock className="h-3.5 w-3.5" /> Historical period — read only
            </span>
          )}
          {isAllPharmacies && (
            <span className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-warning">
              <AlertTriangle className="h-3.5 w-3.5" /> Viewing all pharmacies — read only. Select one pharmacy to make changes.
            </span>
          )}
        </div>
      </div>

      <ScopeLabel period={period ? `${MONTH_NAMES[period.month - 1]} ${period.year}` : undefined} />

      {period && (
        <div className="card flex flex-wrap items-end gap-4 p-4">
          {view === 'daily' && (
            <div>
              <label className="label-text">As of date</label>
              <input
                className="input-field"
                type="date"
                min={`${period.year}-${String(period.month).padStart(2, '0')}-01`}
                max={`${period.year}-${String(period.month).padStart(2, '0')}-${String(new Date(period.year, period.month, 0).getDate()).padStart(2, '0')}`}
                value={selectedDate ?? ''}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className="label-text">Expiring within</label>
            <select
              className="input-field"
              value={filters.expiry}
              onChange={(e) => setFilters((f) => ({ ...f, expiry: e.target.value }))}
            >
              <option value="all">Any time</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </select>
          </div>
          <div>
            <label className="label-text">Manufacturer</label>
            <select
              className="input-field"
              value={filters.manufacturer}
              onChange={(e) => setFilters((f) => ({ ...f, manufacturer: e.target.value }))}
            >
              <option value="all">All manufacturers</option>
              {manufacturers.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={filters.negativeOnly}
              onChange={(e) => setFilters((f) => ({ ...f, negativeOnly: e.target.checked }))}
            />
            Negative balance / needs replenishment only
          </label>
          {(filters.expiry !== 'all' || filters.manufacturer !== 'all' || filters.negativeOnly) && (
            <button className="text-sm text-gray-400 hover:text-gray-600" onClick={() => setFilters(DEFAULT_FILTERS)}>
              Clear filters
            </button>
          )}
          <span className="ml-auto text-xs text-gray-400">
            {view === 'daily' ? `${dailyRows.length} of ${rows.length} rows` : `${filteredRows.length} of ${rows.length} rows`}
          </span>
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={8} cols={10} />
      ) : !period ? (
        <EmptyState
          title={isAllPharmacies ? 'No accumulator data yet' : `No accumulator records found for ${selectedPharmacy?.name ?? 'this pharmacy'}`}
          message={
            canWrite
              ? 'Start the first month for this pharmacy to begin tracking inventory.'
              : isAllPharmacies
              ? 'Select a specific pharmacy to start its first accumulator month.'
              : 'Ask an administrator to start the first month for this pharmacy.'
          }
          action={
            canWrite && (
              <button className="btn-primary" onClick={() => setRolloverOpen(true)}>
                Start New Month
              </button>
            )
          }
        />
      ) : view === 'daily' ? (
        isAllPharmacies ? (
          <EmptyState
            title="Select a specific pharmacy"
            message="The Daily Ledger shows one pharmacy's day-by-day balances for every NDC at once — pick a pharmacy above to view it."
          />
        ) : loadingDaily ? (
          <SkeletonTable rows={8} cols={9} />
        ) : dailyRows.length === 0 ? (
          <EmptyState title="No rows match these filters" message="Try clearing a filter above, or picking a different date." />
        ) : (
          <DataTable columns={dailyColumns} rows={dailyRows} rowKey={(r) => r.id} searchPlaceholder="Search NDC, product name, or manufacturer..." />
        )
      ) : filteredRows.length === 0 ? (
        <EmptyState title="No rows match these filters" message="Try clearing a filter above." />
      ) : (
        <DataTable columns={columns} rows={filteredRows} rowKey={(r) => r.id} searchPlaceholder="Search NDC, product name, manufacturer, or CIN..." />
      )}

      <Modal open={Boolean(editingRow)} onClose={() => setEditingRow(null)} title={`Edit ${editingRow?.ndc ?? ''}`}>
        {editingRow && (
          <EditRowForm row={editingRow} onSave={handleSaveEdit} onDelete={handleDeleteRow} onCancel={() => setEditingRow(null)} saving={savingEdit} />
        )}
      </Modal>

      <NdcLedgerModal
        open={Boolean(ledgerRow)}
        onClose={() => setLedgerRow(null)}
        row={ledgerRow}
        facilityId={ledgerRow?.facility_id}
        pharmacyId={ledgerRow?.pharmacy_id}
        month={ledgerRow?.month}
        year={ledgerRow?.year}
      />

      <AddNdcModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        facilityId={selectedFacilityId}
        pharmacyId={selectedPharmacyId}
        period={period}
        onAdded={async () => {
          setAddOpen(false);
          // Use loadPeriods (not refreshRows) since this may be this
          // pharmacy's very first-ever NDC — period can still be null here,
          // and loadPeriods safely (re)derives it and triggers the rows
          // effect below to load, whereas refreshRows would crash on
          // period.month/year being null.
          await loadPeriods();
        }}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        facilityId={selectedFacilityId}
        pharmacyId={selectedPharmacyId}
        period={period}
        onImported={async () => {
          setImportOpen(false);
          // Same reasoning as onAdded above — this may be the first-ever
          // import for this pharmacy, so period can still be null.
          await loadPeriods();
        }}
      />

      <RolloverModal
        open={rolloverOpen}
        onClose={() => setRolloverOpen(false)}
        facilityId={selectedFacilityId}
        pharmacyId={selectedPharmacyId}
        facilityName={selectedFacility?.name}
        pharmacyName={selectedPharmacy?.name}
        periods={periods}
        onRolledOver={async () => {
          setRolloverOpen(false);
          await loadPeriods();
        }}
      />

      <ReceiveInvoiceModal
        open={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        facilityId={selectedFacilityId}
        pharmacyId={selectedPharmacyId}
        currentRows={rows}
        onReceived={async () => {
          setReceiveOpen(false);
          await refreshRows();
        }}
      />
    </div>
  );
}

function AddNdcModal({ open, onClose, facilityId, pharmacyId, period, onAdded }) {
  const toast = useToast();
  const now = new Date();
  const [form, setForm] = useState({ ndc: '', productName: '', packSize: '', qtyOnHand: '', expDay: '', price340b: '', ppu340b: '', cin: '', manufacturer: '' });
  // When there's no existing period yet (this pharmacy's very first NDC),
  // `period` is null — fall back to the current month/year instead of
  // crashing on period.month. The admin can still change it below.
  const [month, setMonth] = useState(period?.month ?? now.getMonth() + 1);
  const [year, setYear] = useState(period?.year ?? now.getFullYear());
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!form.ndc || !form.productName || !form.qtyOnHand) {
      toast.error('NDC, Product Name, and Qty on Hand are required.');
      return;
    }
    const ndc = normalizeNdc(form.ndc);
    if (!ndc) {
      toast.error(`"${form.ndc}" is not a valid NDC.`);
      return;
    }
    // A starting balance is a physical count and should almost never be
    // negative — only ever confirm past this if the admin has actually
    // checked the source and means it, not because of a bad import/typo.
    if (Number(form.qtyOnHand) < 0) {
      const confirmed = window.confirm(
        `Starting Qty on Hand is negative (${form.qtyOnHand}). A starting balance should almost never be negative — double-check the source before continuing. Add it anyway?`
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      await addAccumulatorRow({
        facilityId,
        pharmacyId,
        month,
        year,
        ndc,
        productName: form.productName,
        packSize: form.packSize || null,
        qtyOnHand: form.qtyOnHand,
        expDay: form.expDay || null,
        price340b: form.price340b || null,
        ppu340b: form.ppu340b || null,
        cin: form.cin || null,
        manufacturer: form.manufacturer || null,
      });
      toast.success('NDC added to accumulator.');
      onAdded();
    } catch (err) {
      toast.error(`Add failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add New NDC">
      <div className="space-y-3">
        {!period && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
            This pharmacy has no accumulator period yet — choose the month/year this starting balance belongs to below.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label-text">Month</label>
            <select className="input-field" value={month} disabled={Boolean(period)} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-text">Year</label>
            <input
              className="input-field"
              type="number"
              value={year}
              disabled={Boolean(period)}
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label-text">NDC *</label>
            <input className="input-field" value={form.ndc} onChange={(e) => setForm((f) => ({ ...f, ndc: e.target.value }))} />
          </div>
          <div>
            <label className="label-text">Product Name *</label>
            <input className="input-field" value={form.productName} onChange={(e) => setForm((f) => ({ ...f, productName: e.target.value }))} />
          </div>
          <div>
            <label className="label-text">Pack Size</label>
            <input className="input-field" type="number" value={form.packSize} onChange={(e) => setForm((f) => ({ ...f, packSize: e.target.value }))} />
          </div>
          <div>
            <label className="label-text">Qty on Hand *</label>
            <input className="input-field" type="number" value={form.qtyOnHand} onChange={(e) => setForm((f) => ({ ...f, qtyOnHand: e.target.value }))} />
          </div>
          <div>
            <label className="label-text">340B Price</label>
            <input className="input-field" type="number" step="0.0001" value={form.price340b} onChange={(e) => setForm((f) => ({ ...f, price340b: e.target.value }))} />
          </div>
          <div>
            <label className="label-text">340B PPU</label>
            <input className="input-field" type="number" step="0.0001" value={form.ppu340b} onChange={(e) => setForm((f) => ({ ...f, ppu340b: e.target.value }))} />
          </div>
          <div>
            <label className="label-text">Exp Day</label>
            <input className="input-field" type="date" value={form.expDay} onChange={(e) => setForm((f) => ({ ...f, expDay: e.target.value }))} />
          </div>
          <div>
            <label className="label-text">CIN</label>
            <input className="input-field" value={form.cin} onChange={(e) => setForm((f) => ({ ...f, cin: e.target.value }))} />
          </div>
          <div className="col-span-2">
            <label className="label-text">Manufacturer</label>
            <input className="input-field" value={form.manufacturer} onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Add NDC
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ImportModal({ open, onClose, facilityId, pharmacyId, period, onImported }) {
  const toast = useToast();
  const now = new Date();
  const [workbook, setWorkbook] = useState(null);
  const [sheets, setSheets] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  // `period` is null the very first time this pharmacy is imported (no
  // accumulator rows exist yet to derive a period from) — fall back to the
  // current month/year instead of crashing, and let the admin correct it.
  const [month, setMonth] = useState(period?.month ?? now.getMonth() + 1);
  const [year, setYear] = useState(period?.year ?? now.getFullYear());
  const [acknowledgedNegatives, setAcknowledgedNegatives] = useState(false);
  // Whether to negate the parsed column on the way in. Column NAME alone
  // isn't proof of sign convention (two real files have used the same
  // header for opposite meanings), so this always starts from the parser's
  // best-guess default but the admin can flip it after seeing the preview.
  const [negateConvention, setNegateConvention] = useState(false);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    setAcknowledgedNegatives(false);
    setParsed(null);
    setError(null);

    // Read the workbook ONCE — sheet-switching below re-parses only the
    // already-in-memory workbook, not the raw file bytes, so it's instant
    // instead of re-decoding an 800-row multi-sheet file every click.
    const { workbook: wb, sheets: sheetList, error: readError } = readAccumulatorWorkbook(buf);
    if (readError) {
      setError(readError);
      setWorkbook(null);
      return;
    }
    setWorkbook(wb);
    setSheets(sheetList);
    // Many real accumulator workbooks accumulate one updated sheet per
    // revision through the month (e.g. dated sheet names appended left to
    // right) — the LAST sheet is far more likely to be the current one than
    // the first, but this is only ever a starting guess: the dropdown below
    // always shows every sheet so the admin picks explicitly, never silently.
    const defaultSheet = sheetList[sheetList.length - 1]?.name ?? null;
    setSelectedSheet(defaultSheet);
    runParse(wb, defaultSheet);
  }

  function runParse(wb, sheetName) {
    const result = parseAccumulatorSheet(wb, sheetName);
    if (result.error) {
      setError(result.error);
      setParsed(null);
    } else {
      setError(null);
      setParsed(result);
      setNegateConvention(result.qtyOnHandSuggestNegate);
    }
  }

  function handleSheetChange(sheetName) {
    setSelectedSheet(sheetName);
    setAcknowledgedNegatives(false);
    if (workbook) runParse(workbook, sheetName);
  }

  // Final qty_on_hand per row, applying the admin-confirmed (or -flipped)
  // sign convention to the parser's raw, un-negated value — recomputed
  // instantly on toggle, no re-parse needed.
  const displayRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((r) => {
      const raw = new Decimal(r.qtyOnHandRaw);
      const qty = negateConvention ? raw.negated() : raw;
      return { ...r, qtyOnHand: qty.toString(), negativeQty: qty.isNegative() && !qty.isZero() };
    });
  }, [parsed, negateConvention]);

  const negativeRows = displayRows.filter((r) => r.negativeQty);

  async function handleConfirm() {
    setImporting(true);
    try {
      const count = await importAccumulatorRows({
        facilityId,
        pharmacyId,
        month,
        year,
        rows: displayRows.map((r) => ({
          ndc: r.ndc,
          product_name: r.productName,
          pack_size: r.packSize,
          qty_on_hand: r.qtyOnHand,
          exp_day: r.expDay,
          price_340b: r.price340b,
          ppu_340b: r.ppu340b,
          cin: r.cin,
          manufacturer: r.manufacturer,
        })),
      });
      toast.success(`Imported ${count} accumulator rows.`);
      setParsed(null);
      onImported();
    } catch (err) {
      toast.error(`Import failed — no changes were made: ${err.message}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setParsed(null);
        setError(null);
        setWorkbook(null);
        setSheets([]);
        setSelectedSheet(null);
      }}
      title="Import Accumulator from Excel"
      wide
    >
      {!period && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
          This pharmacy has no accumulator period yet — choose the month/year this starting balance belongs to below.
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label-text">Month</label>
          <select className="input-field" value={month} disabled={Boolean(period)} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-text">Year</label>
          <input
            className="input-field w-28"
            type="number"
            value={year}
            disabled={Boolean(period)}
            onChange={(e) => setYear(Number(e.target.value))}
          />
        </div>
      </div>
      <input type="file" accept=".xlsx,.xls" onChange={handleFile} className="mb-4 block w-full text-sm" />
      {sheets.length > 1 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <label className="label-text text-warning">
            This file has {sheets.length} sheets — pick the one with your current, final numbers. Don&apos;t assume the first sheet is
            the latest; many workbooks add a new updated sheet as the month goes on, so an earlier sheet can be missing NDCs or
            balances that only exist in a later one.
          </label>
          <select className="input-field mt-1" value={selectedSheet ?? ''} onChange={(e) => handleSheetChange(e.target.value)}>
            {sheets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.rowCount} rows)
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">{error}</div>}
      {parsed && (
        <>
          <p className="mb-2 text-sm text-gray-500">
            {parsed.rows.length} valid rows parsed{parsed.skippedRows.length > 0 ? `, ${parsed.skippedRows.length} skipped` : ''} from sheet
            &quot;{selectedSheet}&quot;. Review before confirming — this will upsert into {MONTH_NAMES[month - 1]} {year} for this pharmacy.
          </p>
          <div className="mb-3 rounded-lg border border-teal-100 bg-teal-50 p-3 text-sm text-teal-800">
            <p className="font-semibold">
              This file&apos;s &quot;{parsed.qtyOnHandColumnLabel}&quot; column — what does a NEGATIVE value mean?
            </p>
            <p className="mt-1 text-teal-700">
              The column name alone can&apos;t tell us this — the same header wording has meant opposite things in different files.
              Check a row you know the real answer for below, then pick the one that matches.
            </p>
            <div className="mt-2 space-y-1.5">
              <label className="flex items-start gap-2">
                <input type="radio" className="mt-1" checked={!negateConvention} onChange={() => setNegateConvention(false)} />
                <span>
                  <strong>Physical count</strong> — negative means a real shortage/backorder. Import values as-is.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" className="mt-1" checked={negateConvention} onChange={() => setNegateConvention(true)} />
                <span>
                  <strong>Running-ledger balance</strong> — negative means surplus/over-replenished (what you already have), positive
                  means a shortage. Sign-flip on import to match the app&apos;s physical-count convention.
                </span>
              </label>
            </div>
          </div>
          {negativeRows.length > 0 && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
              <p className="font-semibold">
                {negativeRows.length} row{negativeRows.length > 1 ? 's have' : ' has'} a NEGATIVE starting Qty on Hand (highlighted below).
              </p>
              <p className="mt-1">
                A starting balance is a physical count and should almost never be negative — double-check the source file&apos;s
                column before importing. Negative starting balances silently compound: every claim against that NDC will subtract
                further, deepening an already-wrong number.
              </p>
              <label className="mt-2 flex items-center gap-2 font-medium">
                <input type="checkbox" checked={acknowledgedNegatives} onChange={(e) => setAcknowledgedNegatives(e.target.checked)} />
                I&apos;ve verified these negative values are correct, not a data error.
              </label>
            </div>
          )}
          <div className="max-h-72 overflow-auto rounded-lg border border-gray-100">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-alt">
                <tr>
                  <th className="px-3 py-2">NDC</th>
                  <th className="px-3 py-2">Product Name</th>
                  <th className="px-3 py-2">Qty on Hand</th>
                  <th className="px-3 py-2">340B PPU</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.slice(0, 50).map((r, i) => (
                  <tr key={i} className={`${i % 2 ? 'bg-surface-alt' : 'bg-white'} ${r.negativeQty ? 'bg-red-50/60' : ''}`}>
                    <td className="px-3 py-1.5 font-mono">{r.ndc}</td>
                    <td className="px-3 py-1.5">{r.productName}</td>
                    <td className={`px-3 py-1.5 ${r.negativeQty ? 'font-semibold text-danger' : ''}`}>{r.qtyOnHand}</td>
                    <td className="px-3 py-1.5">{r.ppu340b ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose} disabled={importing}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={handleConfirm}
              disabled={importing || (negativeRows.length > 0 && !acknowledgedNegatives)}
            >
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm Import
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function RolloverModal({ open, onClose, facilityId, pharmacyId, facilityName, pharmacyName, periods, onRolledOver }) {
  const toast = useToast();
  const [preview, setPreview] = useState([]);
  const [rollingOver, setRollingOver] = useState(false);

  const fromPeriod = periods[0] ?? null;
  const toPeriod = fromPeriod
    ? fromPeriod.month === 12
      ? { month: 1, year: fromPeriod.year + 1 }
      : { month: fromPeriod.month + 1, year: fromPeriod.year }
    : { month: new Date().getMonth() + 1, year: new Date().getFullYear() };

  useEffect(() => {
    async function loadPreview() {
      if (!open || !fromPeriod) return;
      const rows = await fetchAccumulatorRows(facilityId, pharmacyId, fromPeriod.month, fromPeriod.year);
      setPreview(
        rows.map((r) => ({
          ndc: r.ndc,
          product_name: r.product_name,
          qty_on_hand: r.qty_on_hand,
          packs_on_hand: packsOnHand(r.qty_on_hand, r.pack_size).value,
          cost_on_hand_340b: costOnHand340b(r.qty_on_hand, r.ppu_340b),
        }))
      );
    }
    loadPreview();
  }, [open, facilityId, pharmacyId, fromPeriod]);

  async function handleConfirm() {
    setRollingOver(true);
    try {
      const count = await rolloverMonth({
        facilityId,
        pharmacyId,
        fromMonth: fromPeriod.month,
        fromYear: fromPeriod.year,
        toMonth: toPeriod.month,
        toYear: toPeriod.year,
      });
      toast.success(`Rolled over ${count} rows into ${toPeriod.month}/${toPeriod.year} for ${pharmacyName}.`);
      onRolledOver();
    } catch (err) {
      toast.error(`Rollover failed: ${err.message}`);
    } finally {
      setRollingOver(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Start New Month — ${facilityName ?? ''} → ${pharmacyName ?? ''}`} wide>
      {!fromPeriod ? (
        <p className="text-sm text-gray-500">
          No prior accumulator exists for {pharmacyName}. Use &quot;Import Excel&quot; instead to set up the first month&apos;s starting balances.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500">
            This copies {preview.length} rows from {MONTH_NAMES[fromPeriod.month - 1]} {fromPeriod.year} into {MONTH_NAMES[toPeriod.month - 1]}{' '}
            {toPeriod.year} for {pharmacyName} only, carrying forward ending Qty on Hand as the new starting balance.
          </p>
          <div className="max-h-72 overflow-auto rounded-lg border border-gray-100">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-alt">
                <tr>
                  <th className="px-3 py-2">NDC</th>
                  <th className="px-3 py-2">Product Name</th>
                  <th className="px-3 py-2">New Starting Qty</th>
                  <th className="px-3 py-2">Packs on Hand</th>
                  <th className="px-3 py-2">Cost on Hand</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 50).map((r, i) => (
                  <tr key={i} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                    <td className="px-3 py-1.5 font-mono">{r.ndc}</td>
                    <td className="px-3 py-1.5">{r.product_name}</td>
                    <td className="px-3 py-1.5">{formatQty(r.qty_on_hand)}</td>
                    <td className="px-3 py-1.5">{r.packs_on_hand ? formatQty(r.packs_on_hand) : '—'}</td>
                    <td className="px-3 py-1.5">{formatCurrency(r.cost_on_hand_340b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose} disabled={rollingOver}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleConfirm} disabled={rollingOver}>
              {rollingOver && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm Rollover
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

const RECEIVE_STATUS_LABEL = {
  ok: 'Ready',
  invalid_ndc: 'Not an NDC',
  invalid_size: 'Ambiguous size',
  backordered: 'Backordered',
  unmatched: 'Not in accumulator',
};
const RECEIVE_STATUS_CLASS = {
  ok: 'bg-green-50 text-success',
  invalid_ndc: 'bg-gray-100 text-gray-600',
  invalid_size: 'bg-amber-50 text-warning',
  backordered: 'bg-gray-100 text-gray-600',
  unmatched: 'bg-amber-50 text-warning',
};

/**
 * Upload a wholesaler invoice/order PDF and apply it to the running
 * balance: New Balance = Current Balance + (Pack Size x Invoiced Qty) —
 * computed with decimal.js, never native arithmetic. Every parsed line is
 * shown with a status; only "Ready" lines (valid NDC, valid single numeric
 * size, actually invoiced, matched to a row in the CURRENT period) are ever
 * submitted — everything else is visibly skipped with a reason, never
 * silently guessed or dropped.
 */
function ReceiveInvoiceModal({ open, onClose, facilityId, pharmacyId, currentRows, onReceived }) {
  const toast = useToast();
  const [parsedRows, setParsedRows] = useState(null);
  const [error, setError] = useState(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [receiving, setReceiving] = useState(false);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setParsedRows(null);
    const buf = await file.arrayBuffer();
    const result = await parseCardinalHealthInvoice(buf);
    if (result.error) {
      setError(result.error);
      return;
    }

    const byNdc = new Map(currentRows.map((r) => [r.ndc, r]));

    const enriched = result.rows.map((r) => {
      const accRow = r.ndc ? byNdc.get(r.ndc) : null;
      let status = 'ok';
      let reason = null;
      if (r.invalidNdc) {
        status = 'invalid_ndc';
        reason = 'NDC/UPC could not be normalized to an 11-digit NDC (likely a UPC-coded OTC item) — enter manually if needed.';
      } else if (r.backordered) {
        status = 'backordered';
        reason = 'Invoiced qty is 0 (backordered this shipment) — nothing to add.';
      } else if (r.invalidSize) {
        status = 'invalid_size';
        reason = `Could not determine a single numeric pack size from "${r.sizeRaw}" (e.g. a compound "3X28" pack) — enter manually.`;
      } else if (!accRow) {
        status = 'unmatched';
        reason = "NDC not found in this pharmacy's current accumulator period.";
      }

      // "Order" = Pack Size x Invoiced Qty (what the pharmacy team calls the
      // Order/Order Confirmed column). "New Balance" is the separate,
      // resulting figure: Current Balance + Order — never the same number.
      const orderQty = status === 'ok' ? new Decimal(r.sizeNumeric).times(r.invoicedQty) : null;
      const newBalance = status === 'ok' ? new Decimal(accRow.qty_on_hand ?? 0).plus(orderQty) : null;

      return {
        ...r,
        accumulatorId: accRow?.id ?? null,
        currentBalance: accRow?.qty_on_hand ?? null,
        orderQty,
        newBalance,
        status,
        reason,
      };
    });

    setParsedRows(enriched);
  }

  const validRows = parsedRows?.filter((r) => r.status === 'ok') ?? [];

  async function handleConfirm() {
    if (validRows.length === 0) return;
    setReceiving(true);
    try {
      const count = await receiveInvoiceBulk({
        facilityId,
        pharmacyId,
        lines: validRows.map((r) => ({ accumulatorId: r.accumulatorId, orderQty: r.orderQty.toNumber(), unitCost: r.unitPrice })),
        invoiceNumber: invoiceNumber || null,
      });
      toast.success(`Received ${count} NDC${count === 1 ? '' : 's'} into the accumulator.`);
      setParsedRows(null);
      setInvoiceNumber('');
      onReceived();
    } catch (err) {
      toast.error(`Failed to receive invoice — no changes were made: ${err.message}`);
    } finally {
      setReceiving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setParsedRows(null);
        setError(null);
      }}
      title="Upload Invoice / Order"
      wide
    >
      <p className="mb-3 text-sm text-gray-500">
        Upload a wholesaler invoice PDF (Cardinal Health &quot;invoiceReprint&quot; layout). For each line, the{' '}
        <strong>Order</strong> = Pack Size (SIZE column) &times; Invoiced Qty — never the invoiced qty alone. The{' '}
        <strong>New Balance</strong> is a separate number: Current Balance + Order.
      </p>
      <input type="file" accept=".pdf" onChange={handleFile} className="mb-4 block w-full text-sm" />
      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">{error}</div>}
      {parsedRows && (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <label className="label-text">Invoice / Reference # (optional)</label>
              <input
                className="input-field"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="e.g. 7480837981"
              />
            </div>
          </div>
          <p className="mb-2 text-sm text-gray-500">
            {validRows.length} of {parsedRows.length} lines ready to apply. Rows marked below need manual review and will be
            skipped — no accumulator changes are made for them.
          </p>
          <div className="max-h-96 overflow-auto rounded-lg border border-gray-100">
            <table className="w-full min-w-max text-left text-xs">
              <thead className="sticky top-0 bg-surface-alt">
                <tr>
                  {['NDC', 'Description', 'Size', 'Invoiced Qty', 'Order', 'Current Balance', 'New Balance', 'Status'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold text-navy">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsedRows.map((r, i) => (
                  <tr key={i} className={i % 2 ? 'bg-surface-alt' : 'bg-white'} title={r.reason ?? ''}>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono">{r.ndc ?? r.ndcRaw}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{r.description}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{r.sizeRaw ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{r.invoicedQty ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-semibold">{r.orderQty ? formatQty(r.orderQty) : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{r.currentBalance !== null ? formatQty(r.currentBalance) : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{r.newBalance ? formatQty(r.newBalance) : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span className={`badge ${RECEIVE_STATUS_CLASS[r.status]}`}>{RECEIVE_STATUS_LABEL[r.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose} disabled={receiving}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleConfirm} disabled={receiving || validRows.length === 0}>
              {receiving && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm — Add {validRows.length} NDC{validRows.length === 1 ? '' : 's'} to Accumulator
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
