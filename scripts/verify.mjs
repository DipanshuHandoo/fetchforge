import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skipBrowser = process.argv.includes('--skip-browser');

run('npm', ['run', 'clean', '--loglevel=warn'], { cwd: root });
run('npm', ['run', 'typecheck', '--loglevel=warn'], { cwd: root });
run('npm', ['run', 'lint', '--loglevel=warn'], { cwd: root });
run('npm', ['run', 'format:check', '--loglevel=warn'], { cwd: root });
run('npm', ['run', 'test:coverage', '--loglevel=warn'], { cwd: root });
run('npm', ['run', 'build', '--loglevel=warn'], { cwd: root });
run(process.execPath, ['scripts/check-package.mjs', '--built'], { cwd: root });
if (!skipBrowser) run(process.execPath, ['scripts/check-browser.mjs'], { cwd: root });
console.log('Release verification passed.');
