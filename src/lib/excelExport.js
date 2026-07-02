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

/**
 * Daily Claims Export: Sheet 1 = pivot summary (NDC, Drug Name, Sum of Qty,
 * Reimbursement Owed), Sheet 2 = raw claim line items.
 */
export function exportDailyClaims(claim, lineItems, { pharmacyName, facilityName }) {
  const pivotSheetRows = lineItems
    .filter((li) => li.matched)
    .map((li) => ({
      NDC: li.ndc,
      'Drug Name': li.product_name,
      'Sum of Qty': qty(li.qty_dispensed),
      'Reimbursement Owed': money(li.reimbursement_owed),
    }));

  const rawSheetRows = lineItems.map((li) => ({
    NDC: li.ndc,
    'Drug Name': li.product_name,
    'Qty Dispensed': qty(li.qty_dispensed),
    'Pack Size': qty(li.pack_size),
    'Packs Dispensed': qty(li.packs_dispensed),
    '340B PPU': money(li.ppu_340b),
    'Reimbursement Owed': money(li.reimbursement_owed),
    'Qty Before': qty(li.qty_before),
    'Qty After': qty(li.qty_after),
    Matched: li.matched ? 'Yes' : 'No',
    'Flag Reason': li.flag_reason ?? '',
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pivotSheetRows), 'Pivot Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rawSheetRows), 'Raw Claim Rows');

  downloadWorkbook(wb, `Claims_${pharmacyName}_${facilityName}_${claim.claim_date}.xlsx`);
}

/** Accumulator Export: one sheet per month in the workbook. monthsData: [{ month, year, rows }] */
export function exportAccumulator(monthsData) {
  const wb = XLSX.utils.book_new();
  for (const { month, year, rows } of monthsData) {
    const sheetRows = rows.map((r) => ({
      NDC: r.ndc,
      'Product Name': r.product_name,
      'Pack Size': qty(r.pack_size),
      'Qty on Hand': qty(r.qty_on_hand),
      'Packs on Hand': qty(r.packs_on_hand),
      'Exp Day': r.exp_day,
      '340B Price': money(r.price_340b),
      '340B PPU': money(r.ppu_340b),
      'Cost on Hand (340B)': money(r.cost_on_hand_340b),
      CIN: r.cin,
      Manufacturer: r.manufacturer,
    }));
    const sheetName = `${String(month).padStart(2, '0')}-${year}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), sheetName);
  }
  downloadWorkbook(wb, `Accumulator_Export_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/** Monthly Reimbursement Report: NDC | Drug Name | Total Qty | Total Packs | 340B PPU | Total Reimbursement Owed | Month, grouped/summarized by pharmacy. */
export function exportMonthlyReimbursementReport(pharmacyGroups, month, year) {
  const wb = XLSX.utils.book_new();
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

/** Audit Log Export: full immutable audit trail for a selected date range. */
export function exportAuditLog(rows, dateFrom, dateTo) {
  const sheetRows = rows.map((r) => ({
    Timestamp: r.timestamp,
    'User Email': r.userEmail ?? r.user_id,
    'Claim ID': r.claim_id ?? '',
    NDC: r.ndc,
    'Product Name': r.product_name ?? '',
    'Prior Qty': qty(r.prior_qty),
    'Qty Dispensed': qty(r.qty_dispensed),
    'New Qty': qty(r.new_qty),
    'Reimbursement Amount': money(r.reimbursement_amount),
    'Action Type': r.action_type,
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), 'Audit Log');
  downloadWorkbook(wb, `Audit_Log_${dateFrom}_to_${dateTo}.xlsx`);
}
