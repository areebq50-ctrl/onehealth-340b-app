import * as XLSX from 'xlsx';
import { toDecimal } from './calculations.js';

/** Round a value to 2dp and return a plain JS number for Excel cell output — export-time only, never used mid-calculation. */
function money(value) {
  const d = toDecimal(value);
  return d === null ? null : Number(d.toDecimalPlaces(2).toFixed(2));
}

function qty(value) {
  const d = toDecimal(value);
  return d === null ? null : Number(d.toString());
}

function downloadWorkbook(workbook, filename) {
  XLSX.writeFile(workbook, filename);
}

/** Every export gets a leading "Report Info" sheet identifying facility/pharmacy/report type/range/generated time, without disrupting the data sheets' own column layout. */
function addReportInfoSheet(wb, { reportType, facilityName, pharmacyLabel, rangeLabel }) {
  const infoRows = [
    { Field: 'Report Type', Value: reportType },
    { Field: 'Facility', Value: facilityName ?? 'All Facilities' },
    { Field: 'Pharmacy', Value: pharmacyLabel ?? 'All Pharmacies' },
    { Field: 'Period / Date Range', Value: rangeLabel ?? '' },
    { Field: 'Generated', Value: new Date().toLocaleString() },
  ];
  const sheet = XLSX.utils.json_to_sheet(infoRows, { skipHeader: true });
  XLSX.utils.book_append_sheet(wb, sheet, 'Report Info');
}

/**
 * Daily Claims Export: Sheet 1 = pivot summary (NDC, Drug Name, Sum of Qty,
 * Reimbursement Owed), Sheet 2 = raw claim line items (full RX-level ledger
 * when available).
 */
export function exportDailyClaims(claim, lineItems, { pharmacyName, facilityName }) {
  const wb = XLSX.utils.book_new();
  addReportInfoSheet(wb, {
    reportType: 'Daily Claims Export',
    facilityName,
    pharmacyLabel: pharmacyName,
    rangeLabel: claim.claim_date,
  });

  const pivotSheetRows = lineItems
    .filter((li) => li.matched)
    .map((li) => ({
      NDC: li.ndc,
      'Drug Name': li.product_name,
      'Sum of Qty': qty(li.qty_dispensed),
      'Reimbursement Owed': money(li.reimbursement_owed),
    }));

  const rawSheetRows = lineItems.map((li) => ({
    'RX#': li.rx_number ?? '',
    NDC: li.ndc,
    'Drug Name': li.product_name,
    'Qty Dispensed': qty(li.qty_dispensed),
    'Date Filled': li.date_filled ?? '',
    Pharmacy: pharmacyName,
    Facility: facilityName,
    'Pack Size': qty(li.pack_size),
    'Packs Dispensed': qty(li.packs_dispensed),
    '340B PPU': money(li.ppu_340b),
    'Reimbursement Owed': money(li.reimbursement_owed),
    'Qty Before': qty(li.qty_before),
    'Qty After': qty(li.qty_after),
    Matched: li.matched ? 'Yes' : 'No',
    'Flag Reason': li.flag_reason ?? '',
    Prescriber: li.prescriber ?? '',
    BIN: li.bin ?? '',
    PCN: li.pcn ?? '',
  }));

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pivotSheetRows), 'Pivot Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rawSheetRows), 'Raw Claim Rows');

  downloadWorkbook(wb, `Claims_${pharmacyName}_${facilityName}_${claim.claim_date}.xlsx`);
}

/**
 * Accumulator Export: one sheet per month in the workbook. monthsData:
 * [{ month, year, rows }]. Each row carries pharmacyName — when the export
 * covers "All Pharmacies", every sheet includes a Pharmacy column so rows
 * are never ambiguous about which pharmacy they belong to.
 */
export function exportAccumulator(monthsData, { facilityName, pharmacyLabel } = {}) {
  const wb = XLSX.utils.book_new();
  addReportInfoSheet(wb, {
    reportType: 'Accumulator Export',
    facilityName,
    pharmacyLabel,
    rangeLabel: monthsData.map((m) => `${m.month}/${m.year}`).join(', '),
  });

  for (const { month, year, rows } of monthsData) {
    const sheetRows = rows.map((r) => ({
      NDC: r.ndc,
      'Product Name': r.product_name,
      Pharmacy: r.pharmacyName ?? pharmacyLabel ?? '',
      'Pack Size': qty(r.pack_size),
      'Qty on Hand': qty(r.qty_on_hand),
      'Packs on Hand': qty(r.packs_on_hand),
      'Exp Day': r.exp_day,
      '340B Price': money(r.price_340b),
      '340B PPU': money(r.ppu_340b),
      '340B Cost on Hand': money(r.cost_on_hand_340b),
      CIN: r.cin,
      Manufacturer: r.manufacturer,
    }));
    const sheetName = `${String(month).padStart(2, '0')}-${year}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), sheetName);
  }
  downloadWorkbook(wb, `Accumulator_Export_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/**
 * Monthly Reimbursement Report: NDC | Drug Name | Total Qty | Total Packs |
 * 340B PPU | Total Reimbursement Owed | Month, one sheet per pharmacy, plus
 * a combined all-pharmacies sheet with a Pharmacy column when more than one
 * pharmacy is included.
 */
export function exportMonthlyReimbursementReport(pharmacyGroups, month, year, { facilityName, pharmacyLabel } = {}) {
  const wb = XLSX.utils.book_new();
  addReportInfoSheet(wb, {
    reportType: 'Monthly Reimbursement Report',
    facilityName,
    pharmacyLabel,
    rangeLabel: `${month}/${year}`,
  });

  if (pharmacyGroups.length > 1) {
    const combinedRows = pharmacyGroups.flatMap((group) =>
      group.rows.map((r) => ({
        Pharmacy: group.pharmacyName,
        NDC: r.ndc,
        'Drug Name': r.product_name,
        'Total Qty': qty(r.total_qty),
        'Total Packs': qty(r.total_packs),
        '340B PPU': money(r.ppu_340b),
        'Total Reimbursement Owed': money(r.total_reimbursement),
        Month: `${month}/${year}`,
      }))
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(combinedRows), 'All Pharmacies');
  }

  for (const group of pharmacyGroups) {
    const sheetRows = group.rows.map((r) => ({
      NDC: r.ndc,
      'Drug Name': r.product_name,
      'Total Qty': qty(r.total_qty),
      'Total Packs': qty(r.total_packs),
      '340B PPU': money(r.ppu_340b),
      'Total Reimbursement Owed': money(r.total_reimbursement),
      Month: `${month}/${year}`,
    }));
    const sheetName = group.pharmacyName.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), sheetName);
  }
  downloadWorkbook(wb, `Monthly_Reimbursement_Report_${month}-${year}.xlsx`);
}

/** Audit Log Export: full immutable audit trail for a selected date range, with pharmacy/facility visible on every row. */
export function exportAuditLog(rows, dateFrom, dateTo, { facilityName, pharmacyLabel } = {}) {
  const wb = XLSX.utils.book_new();
  addReportInfoSheet(wb, {
    reportType: 'Audit Log Export',
    facilityName,
    pharmacyLabel,
    rangeLabel: `${dateFrom} to ${dateTo}`,
  });

  const sheetRows = rows.map((r) => ({
    Timestamp: r.timestamp,
    'User Email': r.userEmail ?? r.user_id,
    Facility: r.facilityName ?? '',
    Pharmacy: r.pharmacyName ?? '',
    'Claim ID': r.claim_id ?? '',
    NDC: r.ndc,
    'Product Name': r.product_name ?? '',
    'Prior Qty': qty(r.prior_qty),
    'Qty Dispensed': qty(r.qty_dispensed),
    'New Qty': qty(r.new_qty),
    'Reimbursement Amount': money(r.reimbursement_amount),
    'Action Type': r.action_type,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), 'Audit Log');
  downloadWorkbook(wb, `Audit_Log_${dateFrom}_to_${dateTo}.xlsx`);
}

/**
 * Replenishment by NDC — standardized report, separate from the
 * original-format processed workbook. rows: output of buildReplenishmentSummary().
 */
export function exportReplenishmentReport(rows, { facilityName, pharmacyName, claimDate }) {
  const wb = XLSX.utils.book_new();
  addReportInfoSheet(wb, {
    reportType: 'Replenishment by NDC',
    facilityName,
    pharmacyLabel: pharmacyName,
    rangeLabel: claimDate,
  });

  const sheetRows = rows.map((r) => ({
    NDC: r.ndc,
    'Drug Name': r.productName,
    Pharmacy: pharmacyName,
    Facility: facilityName,
    'Qty Dispensed (this batch)': qty(r.qtyDispensed),
    'Claim Lines': r.lineCount,
    'Distinct RX': r.rxCount,
    'Pack Size': qty(r.packSize),
    'Qty Before': qty(r.qtyBefore),
    'Qty After': qty(r.qtyAfter),
    'Shortage Qty': qty(r.shortage),
    'Exact Packs Required': r.exactPacks !== null ? Number(r.exactPacks.toFixed(4)) : null,
    'Recommended Full Packs': qty(r.recommendedPacks),
    'Matched?': r.matched ? 'Yes' : 'No',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), 'Replenishment by NDC');
  downloadWorkbook(wb, `Replenishment_${pharmacyName}_${claimDate}.xlsx`);
}

/**
 * Processed workbook — mirrors the original claims layout (detailed sheet +
 * NDC summary sheet) with processing results appended as new trailing
 * columns, per the "preserve original structure" requirement. Only used
 * when the source file was a raw-sheet .xlsx upload (source columns known).
 */
export function exportProcessedWorkbook(lineItems, { pharmacyName, facilityName, claimDate }) {
  const wb = XLSX.utils.book_new();
  addReportInfoSheet(wb, {
    reportType: 'Processed Claims Workbook',
    facilityName,
    pharmacyLabel: pharmacyName,
    rangeLabel: claimDate,
  });

  const detailRows = lineItems.map((li) => ({
    'Refill No.': li.refill_no ?? '',
    'Refills Auth.': li.refills_auth ?? '',
    'Refills Remain.': li.refills_remain ?? '',
    'Date Filled': li.date_filled ?? '',
    'Date Written': li.date_written ?? '',
    'RX#': li.rx_number ?? '',
    NDC: li.ndc,
    'Drug Name': li.product_name,
    Qty: qty(li.qty_dispensed),
    DS: li.days_supply ?? '',
    'Primary Paid': money(li.primary_paid),
    'Patient Paid': money(li.patient_paid),
    Tax: money(li.tax),
    Fee: money(li.fee),
    Total: money(li.total_paid),
    Primary: li.primary_payer ?? '',
    'Primary BIN': li.bin ?? '',
    'Primary PCN': li.pcn ?? '',
    'Primary Group': li.group_code ?? '',
    'Primary ID': li.member_id ?? '',
    SCC: li.scc ?? '',
    Prescriber: li.prescriber ?? '',
    'Prescriber NPI': li.prescriber_npi ?? '',
    Facility: facilityName,
    Pharmacy: pharmacyName,
    'Claim Date': claimDate,
    'Match Status': li.matched ? 'Matched' : 'Unmatched',
    'Error/Unmatched Reason': li.flag_reason ?? '',
    'Pack Size': qty(li.pack_size),
    'Accumulator Before': qty(li.qty_before),
    'Accumulator After': qty(li.qty_after),
    'Reimbursement': money(li.reimbursement_owed),
  }));

  const summaryMap = new Map();
  for (const li of lineItems) {
    if (!li.matched) continue;
    const existing = summaryMap.get(li.ndc) ?? { name: li.product_name, qty: 0 };
    existing.qty += Number(li.qty_dispensed ?? 0);
    summaryMap.set(li.ndc, existing);
  }
  const summaryRows = Array.from(summaryMap.entries()).map(([ndc, v]) => ({
    NDC: ndc,
    'Drug Name': v.name,
    'Sum of Qty': v.qty,
  }));

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Sheet1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), 'Sheet');
  downloadWorkbook(wb, `Processed_${pharmacyName}_${facilityName}_${claimDate}.xlsx`);
}
