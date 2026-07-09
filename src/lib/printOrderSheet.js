import { formatCurrency, formatQty } from './calculations.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Opens a clean, print-only window containing just the replenishment order
 * sheet (rows that actually need ordering) and triggers the browser print
 * dialog — a printable/handoff-ready doc without pulling in a PDF library,
 * and without fighting the app's own CSS since it's a fully separate
 * document. rows: orderPanelRows shape (ndc, productName, recommendedPacks,
 * price340b, totalOrderCost).
 */
export function printOrderSheet(rows, { facilityName, pharmacyName, claimDate }) {
  const totalCost = rows.reduce((sum, r) => sum + (r.totalOrderCost ? Number(r.totalOrderCost) : 0), 0);

  const bodyRows = rows
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.productName)}</td>
          <td class="mono">${escapeHtml(r.ndc)}</td>
          <td class="num">${escapeHtml(formatQty(r.recommendedPacks))}</td>
          <td class="num">${r.price340b !== null && r.price340b !== undefined ? escapeHtml(formatCurrency(r.price340b)) : '—'}</td>
          <td class="num">${r.totalOrderCost !== null ? escapeHtml(formatCurrency(r.totalOrderCost)) : '—'}</td>
        </tr>`
    )
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
      <tr>
        <th>Product Name</th>
        <th>NDC</th>
        <th class="num">Packs to Order</th>
        <th class="num">340B Price</th>
        <th class="num">Total Order Cost</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">Total</td>
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
