/**
 * Minimal markdown renderer for AI assistant responses: paragraphs, bullet
 * lists, and pipe-delimited tables (the shapes Claude's structured-data
 * answers actually produce). Intentionally not a full markdown parser.
 */
function parseTable(lines) {
  const headerCells = lines[0].split('|').map((c) => c.trim()).filter(Boolean);
  const bodyLines = lines.slice(2); // skip header + separator row
  const rows = bodyLines.map((line) => line.split('|').map((c) => c.trim()).filter(Boolean));
  return { headerCells, rows };
}

function isSeparatorRow(line) {
  return /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-');
}

export default function MarkdownLite({ text }) {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.includes('|') && lines[i + 1] && isSeparatorRow(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|')) {
        tableLines.push(lines[j]);
        j++;
      }
      blocks.push({ type: 'table', ...parseTable(tableLines) });
      i = j;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      let j = i;
      while (j < lines.length && /^\s*[-*]\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*[-*]\s+/, ''));
        j++;
      }
      blocks.push({ type: 'list', items });
      i = j;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    blocks.push({ type: 'p', text: line });
    i++;
  }

  return (
    <div className="space-y-2">
      {blocks.map((block, idx) => {
        if (block.type === 'table') {
          return (
            <div key={idx} className="overflow-auto rounded-lg border border-gray-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-alt">
                  <tr>
                    {block.headerCells.map((h, hi) => (
                      <th key={hi} className="whitespace-nowrap px-3 py-2 font-semibold text-navy">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri} className={ri % 2 ? 'bg-surface-alt' : 'bg-white'}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="whitespace-nowrap px-3 py-1.5">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={idx} className="list-disc space-y-1 pl-5 text-sm">
              {block.items.map((item, ii) => (
                <li key={ii}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={idx} className="text-sm leading-relaxed">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}
