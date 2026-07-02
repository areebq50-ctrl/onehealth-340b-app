import { useEffect, useMemo, useState } from 'react';
import { Download, Plus, Upload, CalendarRange, Loader2, Lock, Pencil } from 'lucide-react';
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
} from '../lib/accumulatorApi.js';
import { parseAccumulatorXlsx } from '../parsers/accumulatorXlsxParser.js';
import { exportAccumulator } from '../lib/excelExport.js';
import { formatCurrency, formatQty, packsOnHand, costOnHand340b } from '../lib/calculations.js';
import { normalizeNdc } from '../lib/ndc.js';
import { getExpiryTone, EXPIRY_TONE_CLASSES } from '../components/accumulator/expiry.js';
import DataTable from '../components/common/DataTable.jsx';
import Modal from '../components/common/Modal.jsx';
import { SkeletonTable } from '../components/common/Skeleton.jsx';
import EmptyState from '../components/common/EmptyState.jsx';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function EditRowForm({ row, onSave, onCancel, saving }) {
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
      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="btn-primary" onClick={() => onSave(form)} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}

export default function Accumulator() {
  const { facilities, selectedFacilityId } = useFacility();
  const { isAdmin } = useAuth();
  const toast = useToast();

  const [facilityId, setFacilityId] = useState('');
  const [periods, setPeriods] = useState([]);
  const [period, setPeriod] = useState(null); // { month, year }
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const [editingRow, setEditingRow] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rolloverOpen, setRolloverOpen] = useState(false);

  useEffect(() => {
    if (selectedFacilityId && selectedFacilityId !== 'all') setFacilityId(selectedFacilityId);
    else if (facilities.length > 0 && !facilityId) setFacilityId(facilities[0].id);
  }, [selectedFacilityId, facilities]);

  async function loadPeriods() {
    if (!facilityId) return;
    const p = await fetchPeriods(facilityId);
    setPeriods(p);
    setPeriod(p[0] ?? null);
  }

  useEffect(() => {
    loadPeriods();
  }, [facilityId]);

  useEffect(() => {
    async function loadRows() {
      if (!facilityId || !period) {
        setRows([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const data = await fetchAccumulatorRows(facilityId, period.month, period.year);
        setRows(data);
      } catch (err) {
        toast.error(`Failed to load accumulator: ${err.message}`);
      } finally {
        setLoading(false);
      }
    }
    loadRows();
  }, [facilityId, period]);

  const isLatestPeriod = periods.length > 0 && period && periods[0].month === period.month && periods[0].year === period.year;
  const selectedFacility = facilities.find((f) => f.id === facilityId);

  const columns = useMemo(
    () => [
      { key: 'ndc', label: 'NDC', sortable: true, render: (r) => <span className="font-mono text-xs">{r.ndc}</span> },
      { key: 'product_name', label: 'Product Name', sortable: true },
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
      { key: 'cost_on_hand_340b', label: 'Cost on Hand', sortable: true, accessor: (r) => Number(r.cost_on_hand_340b ?? 0), render: (r) => formatCurrency(r.cost_on_hand_340b) },
      { key: 'manufacturer', label: 'Manufacturer', sortable: true },
      ...(isAdmin && isLatestPeriod
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
    [isAdmin, isLatestPeriod]
  );

  async function handleSaveEdit(form) {
    setSavingEdit(true);
    try {
      await editAccumulatorRow({ id: editingRow.id, ...form });
      toast.success('Accumulator row updated.');
      setEditingRow(null);
      const data = await fetchAccumulatorRows(facilityId, period.month, period.year);
      setRows(data);
    } catch (err) {
      toast.error(`Update failed: ${err.message}`);
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-navy">Accumulator</h1>
          <p className="text-sm text-gray-500">Master drug inventory by facility and month</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-secondary"
            onClick={() =>
              rows.length > 0 && exportAccumulator([{ month: period.month, year: period.year, rows }])
            }
          >
            <Download className="h-4 w-4" /> Export
          </button>
          {isAdmin && (
            <>
              <button className="btn-secondary" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4" /> Import Excel
              </button>
              <button className="btn-secondary" onClick={() => setRolloverOpen(true)}>
                <CalendarRange className="h-4 w-4" /> Start New Month
              </button>
              <button className="btn-primary" onClick={() => setAddOpen(true)} disabled={!isLatestPeriod && periods.length > 0}>
                <Plus className="h-4 w-4" /> Add NDC
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="label-text">Facility</label>
          <select className="input-field" value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
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
        {!isLatestPeriod && period && (
          <span className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
            <Lock className="h-3.5 w-3.5" /> Historical period — read only
          </span>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={8} cols={10} />
      ) : !period ? (
        <EmptyState
          title="No accumulator data yet"
          message={isAdmin ? 'Start the first month for this facility to begin tracking inventory.' : 'Ask an administrator to start the first month for this facility.'}
          action={
            isAdmin && (
              <button className="btn-primary" onClick={() => setRolloverOpen(true)}>
                Start New Month
              </button>
            )
          }
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} searchPlaceholder="Search NDC or product name..." />
      )}

      <Modal open={Boolean(editingRow)} onClose={() => setEditingRow(null)} title={`Edit ${editingRow?.ndc ?? ''}`}>
        {editingRow && <EditRowForm row={editingRow} onSave={handleSaveEdit} onCancel={() => setEditingRow(null)} saving={savingEdit} />}
      </Modal>

      <AddNdcModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        facilityId={facilityId}
        period={period}
        onAdded={async () => {
          setAddOpen(false);
          const data = await fetchAccumulatorRows(facilityId, period.month, period.year);
          setRows(data);
        }}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        facilityId={facilityId}
        period={period}
        onImported={async () => {
          setImportOpen(false);
          const data = await fetchAccumulatorRows(facilityId, period.month, period.year);
          setRows(data);
        }}
      />

      <RolloverModal
        open={rolloverOpen}
        onClose={() => setRolloverOpen(false)}
        facilityId={facilityId}
        facilityName={selectedFacility?.name}
        periods={periods}
        onRolledOver={async () => {
          setRolloverOpen(false);
          await loadPeriods();
        }}
      />
    </div>
  );
}

function AddNdcModal({ open, onClose, facilityId, period, onAdded }) {
  const toast = useToast();
  const [form, setForm] = useState({ ndc: '', productName: '', packSize: '', qtyOnHand: '', expDay: '', price340b: '', ppu340b: '', cin: '', manufacturer: '' });
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
    setSaving(true);
    try {
      await addAccumulatorRow({
        facilityId,
        month: period.month,
        year: period.year,
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
        <div className="grid grid-cols-2 gap-3">
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

function ImportModal({ open, onClose, facilityId, period, onImported }) {
  const toast = useToast();
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const result = parseAccumulatorXlsx(buf);
    if (result.error) {
      setError(result.error);
      setParsed(null);
    } else {
      setError(null);
      setParsed(result);
    }
  }

  async function handleConfirm() {
    setImporting(true);
    try {
      const count = await importAccumulatorRows({
        facilityId,
        month: period.month,
        year: period.year,
        rows: parsed.rows.map((r) => ({
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
    <Modal open={open} onClose={() => { onClose(); setParsed(null); setError(null); }} title="Import Accumulator from Excel" wide>
      <input type="file" accept=".xlsx,.xls" onChange={handleFile} className="mb-4 block w-full text-sm" />
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">{error}</div>}
      {parsed && (
        <>
          <p className="mb-2 text-sm text-gray-500">
            {parsed.rows.length} valid rows parsed{parsed.skippedRows.length > 0 ? `, ${parsed.skippedRows.length} skipped` : ''}. Review before confirming — this will
            upsert into the current period.
          </p>
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
                {parsed.rows.slice(0, 50).map((r, i) => (
                  <tr key={i} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                    <td className="px-3 py-1.5 font-mono">{r.ndc}</td>
                    <td className="px-3 py-1.5">{r.productName}</td>
                    <td className="px-3 py-1.5">{r.qtyOnHand}</td>
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
            <button className="btn-primary" onClick={handleConfirm} disabled={importing}>
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm Import
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function RolloverModal({ open, onClose, facilityId, facilityName, periods, onRolledOver }) {
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
      const rows = await fetchAccumulatorRows(facilityId, fromPeriod.month, fromPeriod.year);
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
  }, [open, facilityId, fromPeriod]);

  async function handleConfirm() {
    setRollingOver(true);
    try {
      const count = await rolloverMonth({
        facilityId,
        fromMonth: fromPeriod.month,
        fromYear: fromPeriod.year,
        toMonth: toPeriod.month,
        toYear: toPeriod.year,
      });
      toast.success(`Rolled over ${count} rows into ${toPeriod.month}/${toPeriod.year}.`);
      onRolledOver();
    } catch (err) {
      toast.error(`Rollover failed: ${err.message}`);
    } finally {
      setRollingOver(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Start New Month — ${facilityName ?? ''}`} wide>
      {!fromPeriod ? (
        <p className="text-sm text-gray-500">
          No prior accumulator exists for this facility. Use "Import Excel" instead to set up the first month's starting
          balances.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500">
            This copies {preview.length} rows from {MONTH_NAMES[fromPeriod.month - 1]} {fromPeriod.year} into{' '}
            {MONTH_NAMES[toPeriod.month - 1]} {toPeriod.year}, carrying forward ending Qty on Hand as the new starting
            balance.
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
