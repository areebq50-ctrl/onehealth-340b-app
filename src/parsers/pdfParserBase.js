import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/**
 * Extracts every text item from every page of a PDF, grouped by page and
 * approximate row (using y-position clustering), preserving left-to-right
 * reading order within a row. This is the shared primitive every
 * pharmacy-specific parser builds on — pdfjs only gives positioned text
 * fragments, not a table structure.
 */
export async function extractPdfTextRows(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageRows = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    const items = content.items
      .filter((it) => it.str && it.str.trim() !== '')
      .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5] }));

    // Cluster by y-position (rows). Items within 3pt of each other vertically
    // are treated as the same visual row.
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    let currentRow = [];
    let currentY = null;
    for (const item of sorted) {
      if (currentY === null || Math.abs(item.y - currentY) <= 3) {
        currentRow.push(item);
        currentY = currentY === null ? item.y : currentY;
      } else {
        currentRow.sort((a, b) => a.x - b.x);
        rows.push(currentRow);
        currentRow = [item];
        currentY = item.y;
      }
    }
    if (currentRow.length > 0) {
      currentRow.sort((a, b) => a.x - b.x);
      rows.push(currentRow);
    }

    pageRows.push({ pageNum, rows: rows.map((r) => r.map((it) => it.text)) });
  }

  return pageRows;
}

/**
 * Standard parse-result shape every pharmacy PDF parser returns. `rows`
 * should already be normalized to { ndcRaw, drugName, qtyRaw } before
 * NDC-normalization/cleaning is applied by the upload workflow.
 * `needsManualEntry: true` signals the UI to show the manual-entry fallback
 * table instead of trusting the extraction.
 */
export function pdfParseResult({ rows, error = null, needsManualEntry = false, warning = null }) {
  return { rows, error, needsManualEntry, warning };
}
