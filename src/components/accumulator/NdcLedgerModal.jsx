import { useEffect, useState } from 'react';
import { Loader2, ScrollText } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import EmptyState from '../common/EmptyState.jsx';
import { fetchNdcAuditHistory } from '../../lib/accumulatorApi.js';
import { formatCurrency, formatQty, signedPacksToOrder } from '../../lib/calculations.js';
import { useToast } from '../../context/ToastContext.jsx';

const ACTION_LABELS = {
  claim_dispense: 'Claim Dispense',
  claim_reversal: 'Claim Reversal',
  manual_qty_edit: 'Manual Edit',
  rollover: 'Month Rollover',
  manual_add: 'Manually Added',
  import_override: 'Import',
  manual_delete: 'Manual Delete',
  order_received: 'Order Received',
};

const ACTION_TONE = {
  claim_dispense: 'bg-red-50 text-danger',
  claim_reversal: 'bg-amber-50 text-warning',
  manual_qty_edit: 'bg-gray-100 text-gray-600',
  rollover: 'bg-teal-50 text-teal-700',
  manual_add: 'bg-teal-50 text-teal-700',
  import_override: 'bg-teal-50 text-teal-700',
  manual_delete: 'bg-red-50 text-danger',
  order_received: 'bg-green-50 text-success',
};

/**
 * Running, day-by-day ledger for one NDC across a whole period — the
 * "6_22 sheet" view: every event in order (import, each day's dispense,
 * each order received) with the balance and Packs to Order after each
 * one, instead of just the current snapshot the main Accumulator table
 * shows. Built from the immutable accumulator_audit_log, so it's the real
 * chronological record, not a reconstruction.
 */
export default function NdcLedgerModal({ open, onClose, row, facilityId, pharmacyId, month, year }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    if (!open || !row) return;
    let cancelled = false;
    setLoading(true);
    fetchNdcAuditHistory(facilityId, pharmacyId, row.ndc, month, year)
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((err) => {
        if (!cancelled) toast.error(`Failed to load history for ${row.ndc}: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row, facilityId, pharmacyId, month, year]);

  if (!row) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Running Ledger — ${row.ndc} · ${row.product_name}`} xwide>
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-100 bg-surface-alt p-3 text-sm text-gray-600">
          Every recorded event for this NDC this period, in order — pulled directly from the immutable audit log, not a
          reconstruction. Pack Size used for Packs to Order below is the current value ({row.pack_size ?? '—'}); if it changed
          mid-period, earlier rows still use today&apos;s pack size.
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading history...
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={ScrollText} title="No history yet" message="Nothing has been recorded for this NDC this period." />
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-gray-100">
            <table className="w-full min-w-max text-left text-sm">
              <thead className="sticky top-0 bg-surface-alt">
                <tr>
                  {['Date', 'Event', 'By', 'Prior Balance', 'Change', 'New Balance', 'Packs to Order'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-2.5 font-semibold text-navy">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const change = Number(e.new_qty ?? 0) - Number(e.prior_qty ?? 0);
                  const signed = signedPacksToOrder(e.new_qty, row.pack_size);
                  return (
                    <tr key={e.id} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                      <td className="whitespace-nowrap px-4 py-2 text-xs">{new Date(e.timestamp).toLocaleString()}</td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <span className={`badge ${ACTION_TONE[e.action_type] ?? 'bg-gray-100 text-gray-600'}`}>
                          {ACTION_LABELS[e.action_type] ?? e.action_type}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-500">{e.userEmail}</td>
                      <td className="whitespace-nowrap px-4 py-2">{formatQty(e.prior_qty)}</td>
                      <td className={`whitespace-nowrap px-4 py-2 font-medium ${change < 0 ? 'text-danger' : change > 0 ? 'text-success' : ''}`}>
                        {change > 0 ? '+' : ''}
                        {formatQty(change)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 font-semibold">
                        <span className={Number(e.new_qty) < 0 ? 'text-danger' : ''}>{formatQty(e.new_qty)}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">{signed.flagged ? '—' : formatQty(signed.value, 4)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {entries.some((e) => e.reimbursement_amount !== null) && (
          <p className="text-xs text-gray-400">
            Total reimbursement recorded this period for this NDC:{' '}
            <strong>
              {formatCurrency(entries.reduce((sum, e) => sum + Number(e.reimbursement_amount ?? 0), 0))}
            </strong>
          </p>
        )}
      </div>
    </Modal>
  );
}
