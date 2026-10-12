import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function cell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function writeCsv(file, columns, records) {
  await mkdir(path.dirname(file), { recursive: true });
  const rows = [columns, ...records.map((record) => columns.map((key) => record[key]))];
  await writeFile(file, `${rows.map((row) => row.map(cell).join(',')).join('\n')}\n`);
  console.log('[CSV report]', file, records.length, 'rows');
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log('[JSON report]', file);
}
