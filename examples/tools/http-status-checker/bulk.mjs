import path from 'node:path';
import { checkBulk } from './checker.mjs';
import { createStatusClient } from './client.mjs';
import { reportsDir, writeCsv } from './report.mjs';
import { loadUrls } from './urls.mjs';

const { urls, close } = await loadUrls();
const { client, stats } = createStatusClient();
try {
  const records = await checkBulk(client, urls);
  console.log('[results]', records);
  await writeCsv(records, path.join(reportsDir, 'status-bulk.csv'));
  console.log('[monitor summary]', stats.snapshot());
} finally {
  stats.stop();
  await close();
}
