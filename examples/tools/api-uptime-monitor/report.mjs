import path from 'node:path';
import { writeCsv, writeJson } from '../_shared/report.mjs';

export async function reportCycle(result, dir = path.join(import.meta.dirname, 'reports')) {
  await writeCsv(
    path.join(dir, 'checks.csv'),
    [
      'name',
      'at',
      'status',
      'healthy',
      'durationMs',
      'attempts',
      'count',
      'availability',
      'latencyCompliance',
      'sloHealthy',
      'error',
    ],
    result.records,
  );
  await writeJson(path.join(dir, 'summary.json'), result);
}
