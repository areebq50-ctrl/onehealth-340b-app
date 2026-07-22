import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatCurrency, formatQty } from './calculations.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const HEADERS = ['Product Name', 'NDC', 'Pack Size', 'Packs to Order', '340B Price', 'Total Order Cost'];

/** rows: {ndc, productName, packSize, recommendedPacks, price340b, totalOrderCost} — same shape used by both printOrderSheet and downloadOrderSheetPdf. */
function toDisplayRow(r) {
  return [
    r.productName ?? '',
    r.ndc ?? '',
    r.packSize !== null && r.packSize !== undefined ? formatQty(r.packSize) : '—',
    formatQty(r.recommendedPacks),
    r.price340b !== null && r.price340b !== undefined ? formatCurrency(r.price340b) : '—',
    r.totalOrderCost !== null && r.totalOrderCost !== undefined ? formatCurrency(r.totalOrderCost) : '—',
  ];
}

/**
 * Opens a clean, print-only window containing just the replenishment order
 * sheet (rows that actually need ordering) and triggers the browser print
 * dialog — a printable/handoff-ready doc without fighting the app's own CSS
 * since it's a fully separate document. rows: {ndc, productName, packSize,
 * recommendedPacks, price340b, totalOrderCost}.
 */
export function printOrderSheet(rows, { facilityName, pharmacyName, claimDate }) {
  const totalCost = rows.reduce((sum, r) => sum + (r.totalOrderCost ? Number(r.totalOrderCost) : 0), 0);

  const bodyRows = rows
    .map((r) => {
      const [name, ndc, packSize, packs, price, total] = toDisplayRow(r);
      return `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td class="mono">${escapeHtml(ndc)}</td>
          <td class="num">${escapeHtml(packSize)}</td>
          <td class="num">${escapeHtml(packs)}</td>
          <td class="num">${escapeHtml(price)}</td>
          <td class="num">${escapeHtml(total)}</td>
        </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Order Sheet - ${escapeHtml(pharmacyName)} - ${escapeHtml(claimDate)}</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a2332; margin: 32px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.meta { font-size: 12px; color: #64748b; margin: 0 0 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
  th { background: #f1f5f9; }
  td.num, th.num { text-align: right; }
  td.mono { font-family: ui-monospace, monospace; font-size: 12px; }
  tfoot td { font-weight: 600; border-top: 2px solid #1a2332; }
  @media print { body { margin: 12px; } }
</style>
</head>
<body>
  <h1>Replenishment Order Sheet</h1>
  <p class="meta">${escapeHtml(facilityName)} &rarr; ${escapeHtml(pharmacyName)} &middot; Claim date ${escapeHtml(claimDate)} &middot; Generated ${escapeHtml(new Date().toLocaleString())}</p>
  <table>
    <thead>
      <tr>${HEADERS.map((h) => `<th class="${h === 'Product Name' || h === 'NDC' ? '' : 'num'}">${h}</th>`).join('')}</tr>
    </thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="5">Total</td>
        <td class="num">${escapeHtml(formatCurrency(totalCost))}</td>
      </tr>
    </tfoot>
  </table>
</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) return;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.onload = () => printWindow.print();
}

/**
 * Generates and downloads an actual PDF file (not a browser print dialog)
 * of the same order sheet — for saving/emailing/attaching without needing
 * to go through "Print -> Save as PDF" manually.
 */
export function downloadOrderSheetPdf(rows, { facilityName, pharmacyName, claimDate }) {
  const totalCost = rows.reduce((sum, r) => sum + (r.totalOrderCost ? Number(r.totalOrderCost) : 0), 0);

  const doc = new jsPDF({ unit: 'pt' });
  doc.setFontSize(14);
  doc.text('Replenishment Order Sheet', 40, 40);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`${facilityName} -> ${pharmacyName} | Claim date ${claimDate} | Generated ${new Date().toLocaleString()}`, 40, 56);

  autoTable(doc, {
    startY: 72,
    head: [HEADERS],
    body: rows.map(toDisplayRow),
    foot: [['Total', '', '', '', '', formatCurrency(totalCost)]],
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [241, 245, 249], textColor: [26, 35, 50], fontStyle: 'bold' },
    footStyles: { fillColor: [255, 255, 255], textColor: [26, 35, 50], fontStyle: 'bold', lineWidth: { top: 1 } },
    columnStyles: {
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
    },
  });

  doc.save(`Order_Sheet_${pharmacyName}_${claimDate}.pdf`);
}
