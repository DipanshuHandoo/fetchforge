import { rm } from 'node:fs/promises';

for (const dir of ['dist', 'coverage']) {
  await rm(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true });
}
console.log('Cleaned dist and coverage.');
