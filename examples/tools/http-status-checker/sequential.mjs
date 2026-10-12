import path from 'node:path';
import { checkUrl } from './checker.mjs';
import { createStatusClient } from './client.mjs';
import { reportsDir, writeCsv } from './report.mjs';
import { loadUrls } from './urls.mjs';

const { urls, close } = await loadUrls();
const { client, stats } = createStatusClient();
try {
  const records = [];
  for (const url of urls) {
    const record = await checkUrl(client, url);
    console.log('[result]', record);
    records.push(record);
  }
  await writeCsv(records, path.join(reportsDir, 'status-sequential.csv'));
  console.log('[monitor summary]', stats.snapshot());
} finally {
  stats.stop();
  await close();
}
