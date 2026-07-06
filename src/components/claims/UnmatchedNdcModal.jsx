import { useEffect, useState } from 'react';
import { Loader2, Search, CircleCheck, SkipForward, TriangleAlert } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import { lookupNdcFromFda } from '../../lib/ndcLookup.js';
import { resolveUnmatchedLine } from '../../lib/accumulatorApi.js';
import { useToast } from '../../context/ToastContext.jsx';

const emptyForm = {
  productName: '',
  packSize: '',
  qtyOnHand: '0',
  expDay: '',
  price340b: '',
  ppu340b: '',
  cin: '',
  manufacturer: '',
};

/**
 * "Never silently drop an unmatched NDC" workflow. Opened for one unmatched
 * claim_line_items row at a time. Runs an openFDA lookup automatically,
 * pre-fills whatever it finds (Product Name / Manufacturer / a Pack Size
 * suggestion only — openFDA has no 340B pricing data), and lets the user
 * review/correct every field before confirming. The user can instead skip
 * the NDC with a mandatory reason, which is still a recorded resolution,
 * never a silent drop.
 */
export default function UnmatchedNdcModal({ open, onClose, lineItem, onResolved }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [lookupState, setLookupState] = useState('idle'); // idle | loading | found | not_found | error
  const [lookupNote, setLookupNote] = useState(null);
  const [mode, setMode] = useState('add'); // 'add' | 'skip'
  const [skipReason, setSkipReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !lineItem) return;
    setForm({ ...emptyForm, productName: lineItem.product_name ?? '' });
    setMode('add');
    setSkipReason('');
    setLookupState('loading');
    setLookupNote(null);

    let cancelled = false;
    lookupNdcFromFda(lineItem.ndc)
      .then((result) => {
        if (cancelled) return;
        if (!result.found) {
          setLookupState('not_found');
          return;
        }
        setLookupState('found');
        setForm((prev) => ({
          ...prev,
          productName: result.productName || prev.productName,
          manufacturer: result.manufacturer || '',
          packSize: result.packSizeSuggestion ? String(result.packSizeSuggestion) : '',
        }));
        setLookupNote(result.packagingDescription);
      })
      .catch((err) => {
        if (cancelled) return;
        setLookupState('error');
        setLookupNote(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [open, lineItem]);

  function set(field) {
    return (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  async function handleAddAndMatch(e) {
    e.preventDefault();
    if (!form.productName.trim() || !form.packSize || Number(form.packSize) <= 0) {
      toast.error('Product Name and a non-zero Pack Size are required.');
      return;
    }
    // A starting balance is a physical count and should almost never be
    // negative — confirm explicitly rather than silently seeding a
    // brand-new accumulator row with an already-wrong sign.
    if (form.qtyOnHand !== '' && Number(form.qtyOnHand) < 0) {
      const confirmed = window.confirm(
        `Starting Qty on Hand is negative (${form.qtyOnHand}). A starting balance should almost never be negative — double-check before continuing. Add it anyway?`
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      await resolveUnmatchedLine({
        lineItemId: lineItem.id,
        action: 'add_and_match',
        ndc: lineItem.ndc,
        productName: form.productName.trim(),
        packSize: Number(form.packSize),
        qtyOnHand: form.qtyOnHand === '' ? 0 : Number(form.qtyOnHand),
        expDay: form.expDay || null,
        price340b: form.price340b === '' ? null : Number(form.price340b),
        ppu340b: form.ppu340b === '' ? null : Number(form.ppu340b),
        cin: form.cin.trim() || null,
        manufacturer: form.manufacturer.trim() || null,
      });
      toast.success(`${lineItem.ndc} added to the accumulator and matched.`);
      onResolved?.();
      onClose();
    } catch (err) {
      toast.error(`Failed to add and match: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSkip(e) {
    e.preventDefault();
    if (!skipReason.trim()) {
      toast.error('A reason is required to skip this NDC.');
      return;
    }
    setSaving(true);
    try {
      await resolveUnmatchedLine({ lineItemId: lineItem.id, action: 'skip', skipReason: skipReason.trim() });
      toast.success(`${lineItem.ndc} skipped and logged.`);
      onResolved?.();
      onClose();
    } catch (err) {
      toast.error(`Failed to skip: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!lineItem) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Resolve unmatched NDC — ${lineItem.ndc}`} wide>
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-100 bg-surface-alt p-3 text-sm">
          <p>
            <span className="font-medium text-navy">Claims line:</span> {lineItem.product_name || '(no name in source file)'} —{' '}
            qty dispensed {lineItem.qty_dispensed}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            This NDC was not found in this pharmacy&apos;s accumulator for this period. Review the details below, then either add it
            (which also matches and deducts this claim line) or skip it with a reason.
          </p>
        </div>

        {lookupState === 'loading' && (
          <div className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white p-3 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Looking up {lineItem.ndc} in the openFDA NDC directory...
          </div>
        )}
        {lookupState === 'found' && (
          <div className="flex items-start gap-2 rounded-lg border border-teal-100 bg-teal-50 p-3 text-sm text-teal-800">
            <Search className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-medium">Found a match in the openFDA NDC directory.</p>
              <p className="text-xs">
                Product Name, Manufacturer, and a Pack Size suggestion have been pre-filled below — review and correct as needed.
                {lookupNote ? ` Packaging on file: "${lookupNote}".` : ''} openFDA has no 340B pricing data — you must still enter
                340B Price, 340B PPU, and CIN yourself.
              </p>
            </div>
          </div>
        )}
        {lookupState === 'not_found' && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 p-3 text-sm text-warning">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>No match found in the openFDA NDC directory for {lineItem.ndc}. Fill in the details manually below.</p>
          </div>
        )}
        {lookupState === 'error' && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 p-3 text-sm text-warning">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>openFDA lookup failed ({lookupNote}). Fill in the details manually below.</p>
          </div>
        )}

        <div className="flex gap-1 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setMode('add')}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${mode === 'add' ? 'border-teal text-teal-700' : 'border-transparent text-gray-500'}`}
          >
            Add &amp; Match
          </button>
          <button
            type="button"
            onClick={() => setMode('skip')}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${mode === 'skip' ? 'border-teal text-teal-700' : 'border-transparent text-gray-500'}`}
          >
            Skip with Reason
          </button>
        </div>

        {mode === 'add' ? (
          <form onSubmit={handleAddAndMatch} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="label-text">Product Name *</label>
                <input className="input-field" value={form.productName} onChange={set('productName')} required />
              </div>
              <div>
                <label className="label-text">Manufacturer</label>
                <input className="input-field" value={form.manufacturer} onChange={set('manufacturer')} />
              </div>
              <div>
                <label className="label-text">Pack Size *</label>
                <input type="number" step="any" min="0.0001" className="input-field" value={form.packSize} onChange={set('packSize')} required />
              </div>
              <div>
                <label className="label-text">Starting Qty On Hand</label>
                <input type="number" step="any" className="input-field" value={form.qtyOnHand} onChange={set('qtyOnHand')} />
              </div>
              <div>
                <label className="label-text">340B Price</label>
                <input type="number" step="any" min="0" className="input-field" value={form.price340b} onChange={set('price340b')} />
              </div>
              <div>
                <label className="label-text">340B PPU</label>
                <input type="number" step="any" min="0" className="input-field" value={form.ppu340b} onChange={set('ppu340b')} />
              </div>
              <div>
                <label className="label-text">CIN</label>
                <input className="input-field" value={form.cin} onChange={set('cin')} />
              </div>
              <div>
                <label className="label-text">Expiry Date</label>
                <input type="date" className="input-field" value={form.expDay} onChange={set('expDay')} />
              </div>
            </div>
            {(!form.price340b || !form.ppu340b) && (
              <p className="text-xs text-warning">
                340B Price and PPU are blank — openFDA can&apos;t supply these. Reimbursement for this NDC won&apos;t be calculated
                until they&apos;re filled in (here or later via the Accumulator page).
              </p>
            )}
            <button type="submit" className="btn-primary w-full" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleCheck className="h-4 w-4" />}
              Confirm &amp; Add to Accumulator
            </button>
          </form>
        ) : (
          <form onSubmit={handleSkip} className="space-y-3">
            <div>
              <label className="label-text">Reason for skipping *</label>
              <textarea
                className="input-field"
                rows={3}
                value={skipReason}
                onChange={(e) => setSkipReason(e.target.value)}
                placeholder="e.g. Discontinued drug, will not be re-ordered this month"
                required
              />
            </div>
            <button type="submit" className="btn-secondary w-full" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <SkipForward className="h-4 w-4" />}
              Skip This NDC
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}
