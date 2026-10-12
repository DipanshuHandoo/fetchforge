import path from 'node:path';
import { writeCsv, writeJson } from '../_shared/report.mjs';

export async function reportAudit(report, dir = path.join(import.meta.dirname, 'reports')) {
  const flatten = (item) => ({
    ...item,
    chain: item.chain.map((hop) => `${hop.status} ${hop.url}`).join(' -> '),
  });
  const columns = ['url', 'firstStatus', 'finalStatus', 'finalUrl', 'chain', 'error'];
  await writeCsv(path.join(dir, 'pages.csv'), columns, report.pages.map(flatten));
  await writeCsv(path.join(dir, 'links.csv'), ['source', 'outbound', ...columns], report.links.map(flatten));
  await writeJson(path.join(dir, 'summary.json'), { ...report.summary, errors: report.errors });
}
