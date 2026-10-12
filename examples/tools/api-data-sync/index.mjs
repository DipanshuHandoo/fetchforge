import { shutdownSignal } from '../_shared/runtime.mjs';
import { createSyncClients } from './client.mjs';
import { startDemo } from './demo.mjs';
import { input } from './input.mjs';
import { reportSync } from './report.mjs';
import { syncRecords, validateInput } from './sync.mjs';

const shutdown = shutdownSignal();
let demo;
let clients;
try {
  demo = process.argv.includes('--demo') || !input.sourceUrl ? await startDemo() : null;
  const settings = { ...input, ...demo?.input };
  validateInput(settings);
  clients = createSyncClients(settings, shutdown.signal);
  const result = await syncRecords(clients, settings, { stateDir: demo?.stateDir, signal: shutdown.signal });
  await reportSync(result, process.env.FETCHFORGE_EXAMPLE_REPORT_DIR);
  console.log('[sync summary]', result.records, 'records, complete:', result.complete);
  if (!result.complete) process.exitCode = 1;
} catch (error) {
  console.error('[sync failed]', error.code ?? error.name, error.message);
  process.exitCode = 1;
} finally {
  clients?.close();
  shutdown.close();
  await demo?.close();
}
