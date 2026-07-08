import { useEffect, useMemo, useState } from 'react';
import { Loader2, ScrollText } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import EmptyState from '../common/EmptyState.jsx';
import { fetchNdcAuditHistory } from '../../lib/accumulatorApi.js';
import { formatCurrency, formatQty } from '../../lib/calculations.js';
import { groupAuditEntriesByDay } from '../../lib/ledger.js';
import { useToast } from '../../context/ToastContext.jsx';

/**
 * Running, day-by-day ledger for one NDC across a whole period — matches
 * the pharmacy's own spreadsheet pattern (Pack Size, Starting Balance,
 * Dispensed, Order Received, Ending Balance, Packs to Order, one row per
 * day) instead of just the current snapshot the main Accumulator table
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

  const days = useMemo(() => groupAuditEntriesByDay(entries, row?.pack_size), [entries, row]);
  const totalReimbursement = useMemo(
    () => entries.reduce((sum, e) => sum + Number(e.reimbursement_amount ?? 0), 0),
    [entries]
  );

  if (!row) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Running Ledger — ${row.ndc} · ${row.product_name}`} xwide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-100 bg-surface-alt p-3 text-sm">
          <span>
            Pack Size: <strong>{formatQty(row.pack_size)}</strong>
          </span>
          <span>
            Current Balance: <strong className={Number(row.qty_on_hand) < 0 ? 'text-danger' : ''}>{formatQty(row.qty_on_hand)}</strong>
          </span>
          <span className="text-gray-500">One row per day this period, same as your own tracking sheet.</span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading history...
          </div>
        ) : days.length === 0 ? (
          <EmptyState icon={ScrollText} title="No history yet" message="Nothing has been recorded for this NDC this period." />
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-gray-100">
            <table className="w-full min-w-max text-left text-sm">
              <thead className="sticky top-0 bg-surface-alt">
                <tr>
                  {['Date', 'Starting Balance', 'Dispensed', 'Order Received', 'Ending Balance', 'Packs to Order'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-2.5 font-semibold text-navy">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((d, i) => (
                  <tr key={d.date} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                      {d.otherEvents.length > 0 && (
                        <span className="ml-2 badge bg-gray-100 text-gray-500">{d.otherEvents.join(', ')}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">{formatQty(d.startingBalance)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{d.dispensed > 0 ? <span className="text-danger">-{formatQty(d.dispensed)}</span> : '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">{d.ordered > 0 ? <span className="text-success">+{formatQty(d.ordered)}</span> : '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-semibold">
                      <span className={Number(d.endingBalance) < 0 ? 'text-danger' : ''}>{formatQty(d.endingBalance)}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">{d.packsToOrder.flagged ? '—' : formatQty(d.packsToOrder.value, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalReimbursement > 0 && (
          <p className="text-xs text-gray-400">
            Total reimbursement recorded this period for this NDC: <strong>{formatCurrency(totalReimbursement)}</strong>
          </p>
        )}
      </div>
    </Modal>
  );
}
