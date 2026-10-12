import { shutdownSignal } from '../_shared/runtime.mjs';
import { createMonitorClients } from './client.mjs';
import { startDemo } from './demo.mjs';
import { input } from './input.mjs';
import { runMonitor, validateInput } from './monitor.mjs';
import { reportCycle } from './report.mjs';

const shutdown = shutdownSignal();
let demo;
let clients;
try {
  demo = process.argv.includes('--demo') || !input.endpoints.length ? await startDemo() : null;
  const settings = { ...input, ...demo?.input };
  validateInput(settings);
  clients = createMonitorClients(settings);
  const result = await runMonitor(clients, settings, {
    continuous: process.argv.includes('--watch'),
    signal: shutdown.signal,
    report: (result) => reportCycle(result, process.env.FETCHFORGE_EXAMPLE_REPORT_DIR),
  });
  if (result.alertErrors.length || result.records.some((item) => !item.healthy || !item.sloHealthy))
    process.exitCode = 1;
} catch (error) {
  if (!shutdown.signal.aborted) {
    console.error('[monitor failed]', error.message);
    process.exitCode = 1;
  }
} finally {
  clients?.close();
  shutdown.close();
  await demo?.close();
}
