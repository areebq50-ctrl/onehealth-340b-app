import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadCloud, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Loader2, FileWarning, CalendarDays } from 'lucide-react';
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
  computeFileHash,
} from '../lib/claimsApi.js';
import { packsDispensed, reimbursementOwed, newQtyOnHand, formatCurrency, formatQty, sumQty, Decimal } from '../lib/calculations.js';
import { normalizeNdc } from '../lib/ndc.js';
import FacilityPharmacySelector from '../components/common/FacilityPharmacySelector.jsx';
import Modal from '../components/common/Modal.jsx';

function ledgerToRpcRow(row) {
  const l = row.ledger ?? {};
  return {
    ndc: row.ndc,
    product_name: row.drugName,
    qty_dispensed: row.qty.toString(),
    refill_no: l.refillNo ?? null,
    refills_auth: l.refillsAuth ?? null,
    refills_remain: l.refillsRemain ?? null,
    date_filled: l.dateFilled ?? null,
    date_written: l.dateWritten ?? null,
    rx_number: l.rxNumber ?? null,
    days_supply: l.daysSupply ?? null,
    primary_paid: l.primaryPaid ?? null,
    patient_paid: l.patientPaid ?? null,
    tax: l.tax ?? null,
    fee: l.fee ?? null,
    total_paid: l.totalPaid ?? null,
    primary_payer: l.primaryPayer ?? null,
    bin: l.bin ?? null,
    pcn: l.pcn ?? null,
    group_code: l.groupCode ?? null,
    member_id: l.memberId ?? null,
    scc: l.scc ?? null,
    prescriber: l.prescriber ?? null,
    prescriber_npi: l.prescriberNpi ?? null,
  };
}

/**
 * Groups already-cleaned rows by each row's own "Date Filled" ledger field
 * — a source file only *sometimes* spans multiple days, so this only
 * splits into more than one group when the file itself actually carries
 * more than one distinct per-row date. When no row has a Date Filled at
 * all (PDF/manual-entry rows never do), everything falls into a single
 * group under `fallbackDate` — identical to the pre-existing single-date
 * behavior. Sorted chronologically so batches process in order.
 */
function groupRowsByDate(rows, fallbackDate) {
  const anyRowHasDate = rows.some((r) => r.ledger?.dateFilled);
  if (!anyRowHasDate) {
    return [{ date: fallbackDate, rows }];
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.ledger?.dateFilled ?? fallbackDate;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Array.from(groups.entries())
    .map(([date, groupRows]) => ({ date, rows: groupRows }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export default function UploadClaims() {
  const { facilities, pharmaciesForSelectedFacility, selectedFacilityId, selectedPharmacyId } = useFacility();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [claimDate, setClaimDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState(null);
  const [fileHash, setFileHash] = useState(null);

  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState(null);
  const [parseWarning, setParseWarning] = useState(null);
  const [skippedRows, setSkippedRows] = useState([]);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [needsManualEntry, setNeedsManualEntry] = useState(false);
  const [manualRows, setManualRows] = useState([{ ndcRaw: '', drugName: '', qtyRaw: '' }]);
  const [validRows, setValidRows] = useState(null);

  const selectedFacility = facilities.find((f) => f.id === selectedFacilityId);
  const selectedPharmacy = pharmaciesForSelectedFacility.find((p) => p.id === selectedPharmacyId);
  const pharmacySelected = selectedFacilityId !== 'all' && selectedPharmacyId !== 'all';

  const canParse = pharmacySelected && claimDate && file;

  function resetDownstream() {
    setParseError(null);
    setParseWarning(null);
    setSkippedRows([]);
    setNeedsManualEntry(false);
    setManualRows([{ ndcRaw: '', drugName: '', qtyRaw: '' }]);
    setValidRows(null);
  }

  async function handleFileChange(e) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setFileHash(null);
    resetDownstream();
  }

  async function handleParse() {
    if (!canParse) return;
    setParsing(true);
    resetDownstream();
    try {
      const buf = await file.arrayBuffer();
      const hash = await computeFileHash(buf);
      setFileHash(hash);
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
      setParseError('None of the manually entered rows are valid. Check NDC and Qty values.');
      return;
    }
    setSkippedRows(cleaned.skippedRows);
    setValidRows(cleaned.validRows);
    setNeedsManualEntry(false);
  }

  // Manual-entry and generic-PDF rows never carry a per-row Date Filled, so
  // this only ever produces more than one group for an .xlsx upload whose
  // "Date Filled" column genuinely spans multiple days.
  const dateGroups = useMemo(() => (validRows ? groupRowsByDate(validRows, claimDate) : []), [validRows, claimDate]);
  const isMultiDate = dateGroups.length > 1;
  const detectedSingleDateOverride = dateGroups.length === 1 && dateGroups[0].date !== claimDate;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-navy">Upload Claims</h1>
        <p className="text-sm text-gray-500">Process a daily claims file and update the selected pharmacy&apos;s accumulator.</p>
      </div>

      <section className="card p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">1. Facility, Pharmacy & Date</h2>
        <FacilityPharmacySelector includeAllFacilities={false} />
        {selectedFacilityId !== 'all' && selectedPharmacyId === 'all' && (
          <p className="mt-2 text-xs text-warning">Select a specific pharmacy — claims cannot be uploaded against &quot;All Pharmacies&quot;.</p>
        )}
        <div className="mt-4 max-w-xs">
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
          <p className="mt-1 text-xs text-gray-400">
            Used as-is if the file has no per-row dates. If the file&apos;s own &quot;Date Filled&quot; column spans multiple days,
            those dates take over automatically and this file gets split into one batch per day.
          </p>
        </div>

        <div className="mt-4">
          <label className="label-text">Claim File (.xlsx or .pdf)</label>
          <input
            type="file"
            accept=".xlsx,.xls,.pdf"
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-teal-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-teal-700 hover:file:bg-teal-100"
          />
        </div>

        <button className="btn-primary mt-5" disabled={!canParse || parsing} onClick={handleParse}>
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
                  onChange={(e) => setManualRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ndcRaw: e.target.value } : r)))}
                />
                <input
                  className="input-field"
                  placeholder="Drug Name"
                  value={row.drugName}
                  onChange={(e) => setManualRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, drugName: e.target.value } : r)))}
                />
                <input
                  className="input-field"
                  placeholder="Qty"
                  value={row.qtyRaw}
                  onChange={(e) => setManualRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, qtyRaw: e.target.value } : r)))}
                />
                <button className="btn-secondary px-2" onClick={() => setManualRows((prev) => prev.filter((_, idx) => idx !== i))}>
                  &times;
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn-secondary" onClick={() => setManualRows((prev) => [...prev, { ndcRaw: '', drugName: '', qtyRaw: '' }])}>
              + Add Row
            </button>
            <button className="btn-primary" onClick={handleManualEntrySubmit} disabled={parsing}>
              {parsing && <Loader2 className="h-4 w-4 animate-spin" />}
              Continue with these rows
            </button>
          </div>
        </section>
      )}

      {skippedRows.length > 0 && (
        <section className="card p-4">
          <button className="flex w-full items-center justify-between text-sm font-semibold text-navy" onClick={() => setSkippedOpen((o) => !o)}>
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

      {isMultiDate && (
        <div className="flex items-start gap-2 rounded-lg border border-teal-200 bg-teal-50 p-4 text-sm text-teal-800">
          <CalendarDays className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            This file&apos;s own &quot;Date Filled&quot; column has <strong>{dateGroups.length} distinct dates</strong> — it will be
            split into {dateGroups.length} separate claim batches, one per day below. Review and confirm each one independently;
            you can save some now and come back for the rest later.
          </span>
        </div>
      )}

      {!isMultiDate && detectedSingleDateOverride && (
        <div className="flex items-start gap-2 rounded-lg border border-teal-200 bg-teal-50 p-4 text-sm text-teal-800">
          <CalendarDays className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            This file&apos;s own &quot;Date Filled&quot; column says <strong>{dateGroups[0].date}</strong>, not the {claimDate} you
            selected above — using the file&apos;s date since it&apos;s the more reliable source.
          </span>
        </div>
      )}

      {dateGroups.map((g) => (
        <DateBatchCard
          key={g.date}
          dateStr={g.date}
          rows={g.rows}
          skippedRowsCount={skippedRows.length}
          facilityId={selectedFacilityId}
          pharmacyId={selectedPharmacyId}
          facility={selectedFacility}
          pharmacy={selectedPharmacy}
          isAdmin={isAdmin}
          file={file}
          fileHash={fileHash}
          onSaved={(claimId) => navigate(`/claims/${claimId}`)}
        />
      ))}
    </div>
  );
}

/**
 * One claim batch's worth of cross-reference, duplicate-check, preview, and
 * confirm-and-save flow, scoped to a single date and its rows. Rendered
 * once for the common single-date case, or once per detected date when a
 * file's own "Date Filled" column spans multiple days — each instance is
 * fully independent (its own period/duplicate check, its own confirm),
 * so partially confirming a multi-date file is safe.
 */
function DateBatchCard({ dateStr, rows, skippedRowsCount, facilityId, pharmacyId, facility, pharmacy, isAdmin, file, fileHash, onSaved }) {
  const toast = useToast();

  const [crossReferencing, setCrossReferencing] = useState(true);
  const [periodMissing, setPeriodMissing] = useState(false);
  const [matchedRows, setMatchedRows] = useState(null);
  const [reassignInputs, setReassignInputs] = useState({});

  const [existingClaim, setExistingClaim] = useState(null);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [checkingDuplicate, setCheckingDuplicate] = useState(true);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const month = Number(dateStr.slice(5, 7));
  const year = Number(dateStr.slice(0, 4));

  useEffect(() => {
    // Runs once per mounted card — each DateBatchCard instance is keyed by
    // its date string, so React mounts a fresh one (with its own effect
    // run) per distinct date rather than re-running this for a changed
    // `rows` reference.
    let cancelled = false;
    (async () => {
      setCrossReferencing(true);
      try {
        const hasPeriod = await accumulatorPeriodExists(facilityId, pharmacyId, month, year);
        if (cancelled) return;
        setPeriodMissing(!hasPeriod);
        if (hasPeriod) {
          const pivot = pivotByNdc(rows);
          const matched = await matchAgainstAccumulator(facilityId, pharmacyId, month, year, pivot);
          if (cancelled) return;
          setMatchedRows(matched);
        }
      } catch (err) {
        if (!cancelled) toast.error(`Failed to cross-reference accumulator for ${dateStr}: ${err.message}`);
      } finally {
        if (!cancelled) setCrossReferencing(false);
      }

      setCheckingDuplicate(true);
      try {
        const existing = await findExistingClaim(pharmacyId, facilityId, dateStr);
        if (!cancelled) setExistingClaim(existing);
      } catch (err) {
        if (!cancelled) toast.error(`Failed to check for duplicate uploads for ${dateStr}: ${err.message}`);
      } finally {
        if (!cancelled) setCheckingDuplicate(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleReassign(ndc) {
    const targetNdcRaw = reassignInputs[ndc];
    if (!targetNdcRaw) return;
    try {
      const targetNdc = normalizeNdc(targetNdcRaw);
      if (!targetNdc) {
        toast.error('Enter a valid NDC to reassign to.');
        return;
      }
      const acc = await findAccumulatorRow(facilityId, pharmacyId, month, year, targetNdc);
      if (!acc) {
        toast.error(`NDC ${targetNdc} was not found in ${pharmacy?.name ?? 'this pharmacy'}'s accumulator for this period either.`);
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

  const isExactDuplicateFile = existingClaim && fileHash && existingClaim.file_hash && existingClaim.file_hash === fileHash;

  const canConfirm = calcRows.length > 0 && !periodMissing && (!existingClaim || (isAdmin && overwriteConfirmed)) && !saving && !saved;

  async function handleConfirmSave() {
    setConfirmOpen(false);
    setSaving(true);
    try {
      let filePath = null;
      try {
        filePath = await uploadClaimFile(file, {
          facilityShortCode: facility?.short_code ?? 'facility',
          pharmacyName: pharmacy?.name ?? 'pharmacy',
          claimDate: dateStr,
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

      const rawLines = rows.map(ledgerToRpcRow);

      const claimId = await processClaim({
        pharmacyId,
        facilityId,
        claimDate: dateStr,
        filePath,
        lineItems,
        rawLines,
        overwrite: Boolean(existingClaim),
        originalFilename: file?.name ?? null,
        fileHash,
        totalRows: rows.length + skippedRowsCount,
        validRows: rows.length,
        invalidRows: skippedRowsCount,
      });

      toast.success(`Claims for ${facility?.name} → ${pharmacy?.name} dated ${dateStr} were processed successfully.`);
      setSaved(true);
      onSaved(claimId);
    } catch (err) {
      toast.error(`Save failed for ${dateStr} — no changes were made: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Claim Batch — {dateStr} <span className="font-normal text-gray-400">({rows.length} rows)</span>
        </h2>
        {saved && <span className="badge bg-green-50 text-success">Saved</span>}
      </div>

      <div className="space-y-4 p-6">
        {(crossReferencing || checkingDuplicate) && (
          <span className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking...
          </span>
        )}

        {!crossReferencing && periodMissing && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              No accumulator exists for {pharmacy?.name} for {month}/{year}. Go to <strong>Accumulator → Start New Month</strong> for
              this pharmacy before uploading claims for this period.
            </span>
          </div>
        )}

        {existingClaim && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-danger">
            <p className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" />
              {isExactDuplicateFile
                ? 'This exact claim file was already uploaded for this pharmacy'
                : 'A claim already exists for this pharmacy/facility/date'}
            </p>
            <p className="mt-1">
              {existingClaim.original_filename && (
                <>
                  Original file: <strong>{existingClaim.original_filename}</strong>.{' '}
                </>
              )}
              Uploaded {new Date(existingClaim.uploaded_at).toLocaleString()}, totaling {formatCurrency(existingClaim.total_reimbursement)}.
              Confirming will reverse that claim&apos;s accumulator effect and reapply this new data, in a single transaction.
            </p>
            {isAdmin ? (
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" checked={overwriteConfirmed} onChange={(e) => setOverwriteConfirmed(e.target.checked)} />
                I confirm I want to overwrite the existing batch for this pharmacy
              </label>
            ) : (
              <p className="mt-2 font-medium">Only an admin can confirm this overwrite.</p>
            )}
          </div>
        )}

        {calcRows.some((r) => !r.matched) && (
          <div>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-warning">
              <AlertTriangle className="h-4 w-4" /> Unmatched NDCs ({calcRows.filter((r) => !r.matched).length})
            </h3>
            <p className="mb-3 text-sm text-gray-500">
              These NDCs were dispensed but not found in {pharmacy?.name}&apos;s accumulator for this period. They will be recorded
              on the claim for reference but will NOT affect reimbursement totals or on-hand quantities unless reassigned.
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
          </div>
        )}

        {calcRows.some((r) => r.matched) && (
          <div className="overflow-hidden rounded-lg border border-gray-100">
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
              {grandTotals.unmatchedCount > 0 && <span className="text-warning">{grandTotals.unmatchedCount} unmatched</span>}
            </div>
          </div>
        )}

        {calcRows.length > 0 && (
          <div className="flex items-center justify-end gap-3">
            <button className="btn-primary" disabled={!canConfirm} onClick={() => setConfirmOpen(true)}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {saved ? 'Saved' : 'Confirm & Save'}
            </button>
          </div>
        )}
      </div>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title={`Confirm Claim Processing — ${dateStr}`}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-500">You are about to process:</p>
          <dl className="divide-y divide-gray-100 rounded-lg border border-gray-100">
            {[
              ['Facility', facility?.name],
              ['Pharmacy', pharmacy?.name],
              ['Claim Date', dateStr],
              ['Original Filename', file?.name ?? '—'],
              ['Rows in this batch', rows.length],
              ['Matched NDCs', grandTotals.ndcCount],
              ['Unmatched NDCs', grandTotals.unmatchedCount],
              ['Estimated Reimbursement', formatCurrency(grandTotals.totalReimb)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between px-3 py-2">
                <dt className="text-gray-500">{label}</dt>
                <dd className="font-medium text-navy">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-gray-400">
            Confirming will change the accumulator for {pharmacy?.name} only, for {dateStr}. This cannot be undone without admin
            intervention.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleConfirmSave}>
              <CheckCircle2 className="h-4 w-4" /> Confirm &amp; Process
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
