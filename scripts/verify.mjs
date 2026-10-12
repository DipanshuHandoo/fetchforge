import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skipBrowser = process.argv.includes('--skip-browser');

run('npm', ['run', 'clean'], { cwd: root });
run('npm', ['run', 'typecheck'], { cwd: root });
run('npm', ['run', 'lint'], { cwd: root });
run('npm', ['run', 'format:check'], { cwd: root });
run('npm', ['run', 'test:coverage'], { cwd: root });
run('npm', ['run', 'build'], { cwd: root });
run(process.execPath, ['scripts/check-package.mjs', '--built'], { cwd: root });
if (!skipBrowser) run(process.execPath, ['scripts/check-browser.mjs'], { cwd: root });
console.log('Release verification passed.');
