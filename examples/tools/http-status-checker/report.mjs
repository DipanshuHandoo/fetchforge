import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const reportsDir = path.join(import.meta.dirname, 'reports');

function cell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function writeCsv(records, file) {
  const rows = [['url', 'first_status', 'final_status', 'final_url', 'redirect_chain', 'error']];
  for (const record of records) {
    rows.push([
      record.url,
      record.firstStatus,
      record.finalStatus,
      record.finalUrl,
      record.chain.map((hop) => `${hop.status} ${hop.url}`).join(' -> '),
      record.error,
    ]);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${rows.map((row) => row.map(cell).join(',')).join('\n')}\n`);
  console.log('[CSV report]', file, records.length, 'URLs');
}
