import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadCloud, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Loader2, FileWarning } from 'lucide-react';
import { useFacility } from '../context/FacilityContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { parseClaimsXlsx, getPdfParserForPharmacy } from '../parsers/index.js';
import { cleanClaimRows, pivotByNdc } from '../lib/dataCleaning.js';
import {
  findExistingClaim,
  accumulatorPeriodExists,
  findAccumulatorRow,
  matchAgainstAccumulator,
  uploadClaimFile,
  processClaim,
} from '../lib/claimsApi.js';
import { packsDispensed, reimbursementOwed, newQtyOnHand, formatCurrency, formatQty, sumQty, Decimal } from '../lib/calculations.js';
import { normalizeNdc } from '../lib/ndc.js';

const STEPS = ['Select', 'Parse', 'Review', 'Confirm'];

export default function UploadClaims() {
  const { facilities, pharmacies } = useFacility();
  const { isAdmin, profile } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [facilityId, setFacilityId] = useState('');
  const [pharmacyId, setPharmacyId] = useState('');
  const [claimDate, setClaimDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState(null);

  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState(null);
  const [parseWarning, setParseWarning] = useState(null);
  const [skippedRows, setSkippedRows] = useState([]);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [needsManualEntry, setNeedsManualEntry] = useState(false);
  const [manualRows, setManualRows] = useState([{ ndcRaw: '', drugName: '', qtyRaw: '' }]);
  const [validRows, setValidRows] = useState(null);

  const [crossReferencing, setCrossReferencing] = useState(false);
  const [periodMissing, setPeriodMissing] = useState(false);
  const [matchedRows, setMatchedRows] = useState(null); // pivot rows + matched/accumulator
  const [reassignInputs, setReassignInputs] = useState({});

  const [existingClaim, setExistingClaim] = useState(null);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);

  const [saving, setSaving] = useState(false);

  const selectedFacility = facilities.find((f) => f.id === facilityId);
  const facilityPharmacies = useMemo(
    () => pharmacies.filter((p) => !facilityId || (p.pharmacy_facilities ?? []).some((pf) => pf.facility_id === facilityId)),
    [pharmacies, facilityId]
  );
  const selectedPharmacy = pharmacies.find((p) => p.id === pharmacyId);

  const claimMonth = claimDate ? Number(claimDate.slice(5, 7)) : null;
  const claimYear = claimDate ? Number(claimDate.slice(0, 4)) : null;

  const canParse = facilityId && pharmacyId && claimDate && file;

  function resetDownstream() {
    setParseError(null);
    setParseWarning(null);
    setSkippedRows([]);
    setNeedsManualEntry(false);
    setManualRows([{ ndcRaw: '', drugName: '', qtyRaw: '' }]);
    setValidRows(null);
    setMatchedRows(null);
    setPeriodMissing(false);
    setExistingClaim(null);
    setOverwriteConfirmed(false);
  }

  async function handleFileChange(e) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    resetDownstream();
  }

  async function handleParse() {
    if (!canParse) return;
    setParsing(true);
    resetDownstream();
    try {
      const buf = await file.arrayBuffer();
      const isPdf = file.name.toLowerCase().endsWith('.pdf');

      let cleaned;
      if (isPdf) {
        const parser = getPdfParserForPharmacy(selectedPharmacy?.name);
        const result = await parser(buf);
        if (result.error && result.rows.length === 0) {
          setParseError(result.error);
          setNeedsManualEntry(true);
          setParsing(false);
          return;
        }
        if (result.warning) setParseWarning(result.warning);
        if (result.needsManualEntry) {
          setNeedsManualEntry(true);
          setManualRows(
            result.rows.length > 0
              ? result.rows.map((r) => ({ ndcRaw: r.ndcRaw, drugName: r.drugName, qtyRaw: r.qtyRaw }))
              : [{ ndcRaw: '', drugName: '', qtyRaw: '' }]
          );
          setParsing(false);
          return;
        }
        cleaned = cleanClaimRows(result.rows);
      } else {
        const result = parseClaimsXlsx(buf);
        if (result.error) {
          setParseError(result.error);
          setSkippedRows(result.skippedRows);
          setParsing(false);
          return;
        }
        cleaned = { validRows: result.validRows, skippedRows: result.skippedRows };
      }

      setSkippedRows(cleaned.skippedRows);
      setValidRows(cleaned.validRows);
      await runCrossReference(cleaned.validRows);
      await runDuplicateCheck();
    } catch (err) {
      setParseError(`Unexpected error while parsing: ${err.message}`);
    } finally {
      setParsing(false);
    }
  }

  async function handleManualEntrySubmit() {
    const rows = manualRows.filter((r) => r.ndcRaw.trim() || r.drugName.trim() || String(r.qtyRaw).trim());
    if (rows.length === 0) {
      toast.warning('Add at least one row before continuing.');
      return;
    }
    const cleaned = cleanClaimRows(rows);
    if (cleaned.validRows.length === 0) {
      toast.error('None of the manually entered rows are valid. Check NDC and Qty values.');
      return;
    }
    setSkippedRows(cleaned.skippedRows);
    setValidRows(cleaned.validRows);
    setNeedsManualEntry(false);
    setParsing(true);
    await runCrossReference(cleaned.validRows);
    await runDuplicateCheck();
    setParsing(false);
  }

  async function runCrossReference(rows) {
    setCrossReferencing(true);
    try {
      const hasPeriod = await accumulatorPeriodExists(facilityId, claimMonth, claimYear);
      setPeriodMissing(!hasPeriod);
      if (!hasPeriod) {
        setMatchedRows(null);
        return;
      }
      const pivot = pivotByNdc(rows);
      const matched = await matchAgainstAccumulator(facilityId, claimMonth, claimYear, pivot);
      setMatchedRows(matched);
    } catch (err) {
      toast.error(`Failed to cross-reference accumulator: ${err.message}`);
    } finally {
      setCrossReferencing(false);
    }
  }

  async function runDuplicateCheck() {
    setCheckingDuplicate(true);
    try {
      const existing = await findExistingClaim(pharmacyId, facilityId, claimDate);
      setExistingClaim(existing);
    } catch (err) {
      toast.error(`Failed to check for duplicate uploads: ${err.message}`);
    } finally {
      setCheckingDuplicate(false);
    }
  }

  async function handleReassign(ndc) {
    const targetNdcRaw = reassignInputs[ndc];
    if (!targetNdcRaw) return;
    try {
      const targetNdc = normalizeNdc(targetNdcRaw);
      if (!targetNdc) {
        toast.error('Enter a valid NDC to reassign to.');
        return;
      }
      const acc = await findAccumulatorRow(facilityId, claimMonth, claimYear, targetNdc);
      if (!acc) {
        toast.error(`NDC ${targetNdc} was not found in the accumulator for this period either.`);
        return;
      }
      setMatchedRows((prev) =>
        prev.map((row) => (row.ndc === ndc ? { ...row, matched: true, accumulator: acc, reassignedTo: targetNdc } : row))
      );
      toast.success(`Reassigned to ${acc.product_name} (${targetNdc}).`);
    } catch (err) {
      toast.error(`Reassign failed: ${err.message}`);
    }
  }

  const calcRows = useMemo(() => {
    if (!matchedRows) return [];
    return matchedRows.map((row) => {
      if (!row.matched || !row.accumulator) {
        return { ...row, flagged: !row.matched };
      }
      const acc = row.accumulator;
      const packs = packsDispensed(row.totalQty, acc.pack_size);
      const reimb = reimbursementOwed(row.totalQty, acc.ppu_340b);
      const onHand = newQtyOnHand(acc.qty_on_hand, row.totalQty);
      return {
        ...row,
        productName: acc.product_name,
        packSize: acc.pack_size,
        packsDispensed: packs,
        ppu: acc.ppu_340b,
        reimbursement: reimb,
        qtyBefore: acc.qty_on_hand,
        qtyAfter: onHand.value,
        isNegative: onHand.isNegative,
      };
    });
  }, [matchedRows]);

  const grandTotals = useMemo(() => {
    const matched = calcRows.filter((r) => r.matched);
    const totalQty = sumQty(matched.map((r) => r.totalQty));
    const totalReimb = matched.reduce((acc, r) => (r.reimbursement ? acc.plus(r.reimbursement) : acc), new Decimal(0));
    return { totalQty, totalReimb, ndcCount: matched.length, unmatchedCount: calcRows.filter((r) => !r.matched).length };
  }, [calcRows]);

  const canConfirm =
    calcRows.length > 0 &&
    !periodMissing &&
    (!existingClaim || (isAdmin && overwriteConfirmed)) &&
    !saving;

  async function handleConfirmSave() {
    setSaving(true);
    try {
      let filePath = null;
      try {
        filePath = await uploadClaimFile(file ?? new Blob(), {
          facilityShortCode: selectedFacility?.short_code ?? 'facility',
          pharmacyName: selectedPharmacy?.name ?? 'pharmacy',
          claimDate,
        });
      } catch (storageErr) {
        // Non-fatal: proceed without a stored file rather than blocking the whole claim.
        // eslint-disable-next-line no-console
        console.error('File storage upload failed:', storageErr.message);
      }

      const lineItems = calcRows.map((r) => ({
        ndc: r.reassignedTo ?? r.ndc,
        qty_dispensed: r.totalQty.toString(),
        matched: r.matched,
        product_name_raw: r.drugName,
      }));

      const claimId = await processClaim({
        pharmacyId,
        facilityId,
        claimDate,
        filePath,
        lineItems,
        overwrite: Boolean(existingClaim),
      });

      toast.success('Claim processed and accumulator updated successfully.');
      navigate(`/day/${claimId}`);
    } catch (err) {
      toast.error(`Save failed — no changes were made: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-navy">Upload Claims</h1>
        <p className="text-sm text-gray-500">Process a daily claims file and update the accumulator.</p>
      </div>

      {/* Step 1: Selection */}
      <section className="card p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">1. Pharmacy, Facility & Date</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="label-text">Facility</label>
            <select
              className="input-field"
              value={facilityId}
              onChange={(e) => {
                setFacilityId(e.target.value);
                setPharmacyId('');
                resetDownstream();
              }}
            >
              <option value="">Select facility...</option>
              {facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-text">Pharmacy</label>
            <select
              className="input-field"
              value={pharmacyId}
              disabled={!facilityId}
              onChange={(e) => {
                setPharmacyId(e.target.value);
                resetDownstream();
              }}
            >
              <option value="">Select pharmacy...</option>
              {facilityPharmacies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-text">Claim Date</label>
            <input
              type="date"
              className="input-field"
              value={claimDate}
              onChange={(e) => {
                setClaimDate(e.target.value);
                resetDownstream();
              }}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="label-text">Claim File (.xlsx or .pdf)</label>
          <div className="flex items-center gap-3">
            <input
              type="file"
              accept=".xlsx,.xls,.pdf"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-teal-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-teal-700 hover:file:bg-teal-100"
            />
          </div>
        </div>

        <button
          className="btn-primary mt-5"
          disabled={!canParse || parsing}
          onClick={handleParse}
        >
          {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
          Parse File
        </button>

        {parseError && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{parseError}</span>
          </div>
        )}
        {parseWarning && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
            <FileWarning className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{parseWarning}</span>
          </div>
        )}
      </section>

      {/* Manual entry fallback */}
      {needsManualEntry && (
        <section className="card p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Manual Entry (PDF extraction was unreliable)
          </h2>
          <div className="space-y-2">
            {manualRows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_2fr_1fr_auto] gap-2">
                <input
                  className="input-field"
                  placeholder="NDC"
                  value={row.ndcRaw}
                  onChange={(e) =>
                    setManualRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ndcRaw: e.target.value } : r)))
                  }
                />
                <input
                  className="input-field"
                  placeholder="Drug Name"
                  value={row.drugName}
                  onChange={(e) =>
                    setManualRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, drugName: e.target.value } : r)))
                  }
                />
                <input
                  className="input-field"
                  placeholder="Qty"
                  value={row.qtyRaw}
                  onChange={(e) =>
                    setManualRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, qtyRaw: e.target.value } : r)))
                  }
                />
                <button
                  className="btn-secondary px-2"
                  onClick={() => setManualRows((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              className="btn-secondary"
              onClick={() => setManualRows((prev) => [...prev, { ndcRaw: '', drugName: '', qtyRaw: '' }])}
            >
              + Add Row
            </button>
            <button className="btn-primary" onClick={handleManualEntrySubmit} disabled={parsing}>
              {parsing && <Loader2 className="h-4 w-4 animate-spin" />}
              Continue with these rows
            </button>
          </div>
        </section>
      )}

      {/* Skipped rows */}
      {skippedRows.length > 0 && (
        <section className="card p-4">
          <button
            className="flex w-full items-center justify-between text-sm font-semibold text-navy"
            onClick={() => setSkippedOpen((o) => !o)}
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              Skipped Rows ({skippedRows.length})
            </span>
            {skippedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {skippedOpen && (
            <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-gray-100">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface-alt">
                  <tr>
                    <th className="px-3 py-2">Row</th>
                    <th className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {skippedRows.map((r, i) => (
                    <tr key={i} className={i % 2 ? 'bg-surface-alt' : 'bg-white'}>
                      <td className="px-3 py-1.5">{r.rowNumber}</td>
                      <td className="px-3 py-1.5 text-gray-600">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Period missing */}
      {periodMissing && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            No accumulator has been set up for {claimMonth}/{claimYear} at this facility yet. Go to{' '}
            <strong>Accumulator → Start New Month</strong> before uploading claims for this period.
          </span>
        </div>
      )}

      {/* Duplicate warning */}
      {existingClaim && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-danger">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> A claim already exists for this pharmacy/facility/date
          </p>
          <p className="mt-1">
            Uploaded {new Date(existingClaim.uploaded_at).toLocaleString()}, totaling{' '}
            {formatCurrency(existingClaim.total_reimbursement)}. Confirming will reverse that claim's accumulator
            effect and reapply this new file, in a single transaction.
          </p>
          {isAdmin ? (
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={overwriteConfirmed} onChange={(e) => setOverwriteConfirmed(e.target.checked)} />
              I confirm I want to overwrite the existing claim
            </label>
          ) : (
            <p className="mt-2 font-medium">Only an admin can confirm this overwrite.</p>
          )}
        </div>
      )}

      {/* Unmatched NDCs */}
      {calcRows.some((r) => !r.matched) && (
        <section className="card p-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-warning">
            <AlertTriangle className="h-4 w-4" /> Unmatched NDCs ({calcRows.filter((r) => !r.matched).length})
          </h2>
          <p className="mb-3 text-sm text-gray-500">
            These NDCs were dispensed but not found in the accumulator for this period. They will be recorded on the
            claim for reference but will NOT affect reimbursement totals or on-hand quantities unless reassigned.
          </p>
          <div className="space-y-2">
            {calcRows
              .filter((r) => !r.matched)
              .map((r) => (
                <div key={r.ndc} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-100 p-3 text-sm">
                  <span className="font-mono">{r.ndc}</span>
                  <span className="text-gray-600">{r.drugName}</span>
                  <span className="ml-auto text-gray-500">Qty: {formatQty(r.totalQty)}</span>
                  <input
                    className="input-field w-40"
                    placeholder="Reassign to NDC..."
                    value={reassignInputs[r.ndc] ?? ''}
                    onChange={(e) => setReassignInputs((prev) => ({ ...prev, [r.ndc]: e.target.value }))}
                  />
                  <button className="btn-secondary px-3 py-1.5" onClick={() => handleReassign(r.ndc)}>
                    Assign
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Preview + totals */}
      {calcRows.some((r) => r.matched) && (
        <section className="card overflow-hidden">
          <div className="border-b border-gray-100 p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Results Preview</h2>
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-max text-left text-sm">
              <thead className="bg-surface-alt">
                <tr>
                  {['NDC', 'Drug Name', 'Qty Dispensed', 'Pack Size', 'Packs Dispensed', '340B PPU', 'Reimbursement', 'Qty Before', 'Qty After'].map(
                    (h) => (
                      <th key={h} className="whitespace-nowrap px-4 py-3 font-semibold text-navy">
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {calcRows
                  .filter((r) => r.matched)
                  .map((r, i) => (
                    <tr key={r.ndc} className={`${i % 2 ? 'bg-surface-alt' : 'bg-white'} ${r.isNegative ? 'bg-red-50' : ''}`}>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{r.ndc}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{r.productName}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{formatQty(r.totalQty)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{r.packSize ?? '—'}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {r.packsDispensed?.flagged ? (
                          <span className="badge bg-amber-50 text-warning">Manual review</span>
                        ) : (
                          formatQty(r.packsDispensed?.value, 2)
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">{formatCurrency(r.ppu)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-semibold">{formatCurrency(r.reimbursement)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{formatQty(r.qtyBefore)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span className={r.isNegative ? 'inline-flex items-center gap-1 font-semibold text-danger' : ''}>
                          {r.isNegative && <AlertTriangle className="h-3.5 w-3.5" />}
                          {formatQty(r.qtyAfter)}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-6 border-t border-gray-100 bg-surface-alt px-6 py-4 text-sm">
            <span>
              <strong>{grandTotals.ndcCount}</strong> NDCs matched
            </span>
            <span>
              Total Qty: <strong>{formatQty(grandTotals.totalQty)}</strong>
            </span>
            <span>
              Total Reimbursement: <strong>{formatCurrency(grandTotals.totalReimb)}</strong>
            </span>
            {grandTotals.unmatchedCount > 0 && (
              <span className="text-warning">{grandTotals.unmatchedCount} unmatched</span>
            )}
          </div>
        </section>
      )}

      {calcRows.length > 0 && (
        <div className="flex items-center justify-end gap-3">
          {checkingDuplicate || crossReferencing ? (
            <span className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking...
            </span>
          ) : null}
          <button className="btn-primary" disabled={!canConfirm} onClick={handleConfirmSave}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Confirm & Save
          </button>
        </div>
      )}
    </div>
  );
}
