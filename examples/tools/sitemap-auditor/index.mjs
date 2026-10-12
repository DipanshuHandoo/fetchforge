import { shutdownSignal } from '../_shared/runtime.mjs';
import { auditSitemap } from './auditor.mjs';
import { createAuditClients } from './client.mjs';
import { startDemo } from './demo.mjs';
import { input } from './input.mjs';
import { reportAudit } from './report.mjs';

const shutdown = shutdownSignal();
let demo;
let clients;
try {
  demo = process.argv.includes('--demo') || !input.sitemap ? await startDemo() : null;
  const settings = { ...input, ...demo?.input };
  clients = createAuditClients(settings, shutdown.signal);
  const result = await auditSitemap(clients, settings, shutdown.signal);
  await reportAudit(result, process.env.FETCHFORGE_EXAMPLE_REPORT_DIR);
  console.log('[audit summary]', result.summary);
  if (!result.summary.complete || result.summary.brokenPages || result.summary.brokenLinks)
    process.exitCode = 1;
} catch (error) {
  console.error('[audit failed]', error.message);
  process.exitCode = 1;
} finally {
  clients?.close();
  shutdown.close();
  await demo?.close();
}
