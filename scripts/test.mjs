import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(new URL('../test', import.meta.url)))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `test/${name}`);

const args = ['--experimental-strip-types', '--no-warnings', '--test'];
if (process.argv.includes('--coverage')) {
  args.push(
    '--experimental-test-coverage',
    '--test-coverage-include=src/**',
    '--test-coverage-lines=90',
    '--test-coverage-branches=80',
    '--test-coverage-functions=85',
  );
}
run(process.execPath, [...args, ...files], { cwd: root });
