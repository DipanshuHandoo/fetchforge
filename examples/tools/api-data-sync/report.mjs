import path from 'node:path';
import { writeCsv, writeJson } from '../_shared/report.mjs';

export async function reportSync(result, dir = path.join(import.meta.dirname, 'reports')) {
  await writeCsv(path.join(dir, 'failures.csv'), ['id', 'code', 'status'], result.failures);
  await writeJson(path.join(dir, 'summary.json'), {
    pages: result.pages,
    records: result.records,
    complete: result.complete,
    alreadyComplete: result.alreadyComplete ?? false,
    failedWrites: result.failures.length,
  });
}
