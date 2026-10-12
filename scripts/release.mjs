import { spawnSync } from 'node:child_process';
import { run } from './run.mjs';

// Interactive release: makes sure you are logged in to npm, then publishes (prepublishOnly runs verify first).
const registry = 'https://registry.npmjs.org/';

function whoami() {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'whoami', '--registry', registry], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

let user = whoami();
if (!user) {
  console.log('Not logged in to npm. Starting "npm login" (follow the prompts)...');
  run('npm', ['login', '--registry', registry]);
  user = whoami();
  if (!user) throw new Error('npm login did not complete; aborting.');
}
console.log(`Publishing as npm user "${user}"...`);
run('npm', ['publish', '--access', 'public', '--registry', registry]);
console.log('Published. Verify with: npm view @dipanshuhandoo/fetchforge version');
