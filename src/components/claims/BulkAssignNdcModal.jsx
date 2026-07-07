import { useEffect, useState } from 'react';
import { Loader2, CircleCheck, TriangleAlert, Search } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import { lookupNdcFromFda } from '../../lib/ndcLookup.js';
import { resolveUnmatchedLine } from '../../lib/accumulatorApi.js';
import { useToast } from '../../context/ToastContext.jsx';

/**
 * Bulk version of UnmatchedNdcModal — runs the openFDA lookup for every
 * unmatched line item in the current claim at once, lets the user review/
 * correct each row inline, then confirms all of them (or a subset) in one
 * click. Same "never silently drop" guarantee as the single-item modal:
 * every row must have a non-zero Pack Size before it can be included, and
 * rows without one are called out rather than silently skipped.
 */
export default function BulkAssignNdcModal({ open, onClose, lineItems, onResolved }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loadingLookups, setLoadingLookups] = useState(false);
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    if (!open || !lineItems || lineItems.length === 0) return;
    setLoadingLookups(true);
    setRows(
      lineItems.map((li) => ({
        lineItemId: li.id,
        ndc: li.ndc,
        qtyDispensed: li.qty_dispensed,
        productName: li.product_name ?? '',
        packSize: '',
        qtyOnHand: '0',
        price340b: '',
        ppu340b: '',
        cin: '',
        manufacturer: '',
        lookupState: 'loading',
        include: true,
      }))
    );

    let cancelled = false;
    Promise.allSettled(lineItems.map((li) => lookupNdcFromFda(li.ndc))).then((results) => {
      if (cancelled) return;
      setRows((prev) =>
        prev.map((row, i) => {
          const result = results[i];
          if (result.status !== 'fulfilled' || !result.value.found) {
            return { ...row, lookupState: result.status === 'fulfilled' ? 'not_found' : 'error' };
          }
          const found = result.value;
          return {
            ...row,
            productName: found.productName || row.productName,
            manufacturer: found.manufacturer || '',
            packSize: found.packSizeSuggestion ? String(found.packSizeSuggestion) : '',
            lookupState: 'found',
          };
        })
      );
      setLoadingLookups(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open, lineItems]);

  function updateRow(lineItemId, field, value) {
    setRows((prev) => prev.map((r) => (r.lineItemId === lineItemId ? { ...r, [field]: value } : r)));
  }

  const readyCount = rows.filter((r) => r.include && r.productName.trim() && Number(r.packSize) > 0).length;
  const missingPackSizeCount = rows.filter((r) => r.include && !(Number(r.packSize) > 0)).length;

  async function handleAssignAll() {
    const toAssign = rows.filter((r) => r.include && r.productName.trim() && Number(r.packSize) > 0);
    if (toAssign.length === 0) {
      toast.error('No rows are ready to assign — every row needs a Product Name and a non-zero Pack Size.');
      return;
    }
    setAssigning(true);
    let succeeded = 0;
    let failed = 0;
    for (const row of toAssign) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await resolveUnmatchedLine({
          lineItemId: row.lineItemId,
          action: 'add_and_match',
          ndc: row.ndc,
          productName: row.productName.trim(),
          packSize: Number(row.packSize),
          qtyOnHand: row.qtyOnHand === '' ? 0 : Number(row.qtyOnHand),
          price340b: row.price340b === '' ? null : Number(row.price340b),
          ppu340b: row.ppu340b === '' ? null : Number(row.ppu340b),
          cin: row.cin.trim() || null,
          manufacturer: row.manufacturer.trim() || null,
        });
        succeeded++;
      } catch (err) {
        failed++;
        toast.error(`${row.ndc} failed: ${err.message}`);
      }
    }
    setAssigning(false);
    const skipped = rows.length - toAssign.length;
    toast.success(
      `${succeeded} NDC${succeeded === 1 ? '' : 's'} assigned to the accumulator.` +
        (failed > 0 ? ` ${failed} failed.` : '') +
        (skipped > 0 ? ` ${skipped} left for individual review.` : '')
    );
    onResolved?.();
    onClose();
  }

  if (!lineItems || lineItems.length === 0) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Assign All Unmatched NDCs (${lineItems.length})`} xwide>
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-100 bg-surface-alt p-3 text-sm text-gray-600">
          openFDA lookup ran automatically for every row below and pre-filled what it could (Product Name / Manufacturer / a Pack
          Size suggestion). Review each row — 340B Price, PPU, and CIN are never available from openFDA and must be entered
          manually if you have them; you can leave them blank and fill them in later on the Accumulator page. Uncheck any row
          you&apos;d rather resolve individually or skip. Rows without a Product Name and non-zero Pack Size can&apos;t be assigned.
        </div>

        {loadingLookups && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Looking up {lineItems.length} NDCs in the openFDA NDC directory...
          </div>
        )}

        <div className="overflow-auto rounded-lg border border-gray-100">
          <table className="w-full min-w-max text-left text-sm">
            <thead className="sticky top-0 bg-surface-alt">
              <tr>
                {['', 'NDC', 'Product Name *', 'Pack Size *', 'Qty On Hand', '340B Price', '340B PPU', 'CIN', 'Manufacturer', 'FDA'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold text-navy">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.lineItemId} className={`${i % 2 ? 'bg-surface-alt' : 'bg-white'} ${!row.include ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={(e) => updateRow(row.lineItemId, 'include', e.target.checked)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{row.ndc}</td>
                  <td className="px-3 py-2">
                    <input
                      className="input-field w-40 py-1"
                      value={row.productName}
                      onChange={(e) => updateRow(row.lineItemId, 'productName', e.target.value)}
                      disabled={!row.include}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className="input-field w-24 py-1"
                      value={row.packSize}
                      onChange={(e) => updateRow(row.lineItemId, 'packSize', e.target.value)}
                      disabled={!row.include}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="any"
                      className="input-field w-24 py-1"
                      value={row.qtyOnHand}
                      onChange={(e) => updateRow(row.lineItemId, 'qtyOnHand', e.target.value)}
                      disabled={!row.include}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className="input-field w-24 py-1"
                      value={row.price340b}
                      onChange={(e) => updateRow(row.lineItemId, 'price340b', e.target.value)}
                      disabled={!row.include}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className="input-field w-24 py-1"
                      value={row.ppu340b}
                      onChange={(e) => updateRow(row.lineItemId, 'ppu340b', e.target.value)}
                      disabled={!row.include}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="input-field w-24 py-1"
                      value={row.cin}
                      onChange={(e) => updateRow(row.lineItemId, 'cin', e.target.value)}
                      disabled={!row.include}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="input-field w-32 py-1"
                      value={row.manufacturer}
                      onChange={(e) => updateRow(row.lineItemId, 'manufacturer', e.target.value)}
                      disabled={!row.include}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {row.lookupState === 'loading' && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                    {row.lookupState === 'found' && <Search className="h-4 w-4 text-teal-600" title="Found in openFDA" />}
                    {row.lookupState === 'not_found' && (
                      <TriangleAlert className="h-4 w-4 text-warning" title="No openFDA match — fill in manually" />
                    )}
                    {row.lookupState === 'error' && <TriangleAlert className="h-4 w-4 text-danger" title="openFDA lookup failed" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {missingPackSizeCount > 0 && (
          <p className="text-xs text-warning">
            {missingPackSizeCount} row{missingPackSizeCount > 1 ? 's are' : ' is'} missing a Product Name or Pack Size and won&apos;t be
            assigned — fill those in above, or leave them for individual review via the Assign NDC button later.
          </p>
        )}

        <button type="button" className="btn-primary w-full" disabled={assigning || loadingLookups} onClick={handleAssignAll}>
          {assigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleCheck className="h-4 w-4" />}
          Assign {readyCount} NDC{readyCount === 1 ? '' : 's'} to the Accumulator
        </button>
      </div>
    </Modal>
  );
}
