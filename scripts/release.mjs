import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
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
console.log(`Logged in as npm user "${user}".`);

const semver = /^(\d+)\.(\d+)\.(\d+)$/;

function npmOutput(args) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function bump(version, kind) {
  const match = semver.exec(version);
  if (!match) throw new Error(`Unsupported version "${version}" (expected MAJOR.MINOR.PATCH).`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'feature') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const published = npmOutput(['view', pkg.name, 'version', '--registry', registry]);
// The registry is the source of truth, so a bump left behind by a failed publish is never compounded.
const base = published && semver.test(published) ? published : null;

const choices = [
  ...(base ? [] : [{ key: 'first', label: `First release (publish ${pkg.version} as is)` }]),
  ...(base
    ? [
        { key: 'bug', label: `Bug fix        -> ${bump(base, 'bug')}` },
        { key: 'feature', label: `Feature        -> ${bump(base, 'feature')}` },
        { key: 'major', label: `Major release  -> ${bump(base, 'major')}` },
      ]
    : []),
];
console.log(base ? `Latest published version: ${base}` : `${pkg.name} is not published yet.`);
for (const [i, c] of choices.entries()) console.log(`  ${i + 1}) ${c.label}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('What kind of change is this? Enter a number: ')).trim();
const choice = choices[Number(answer) - 1];
if (!choice) {
  rl.close();
  throw new Error('Invalid choice; aborting. Nothing was changed.');
}
const next = choice.key === 'first' ? pkg.version : bump(base, choice.key);
const confirm = (await rl.question(`Release ${pkg.name}@${next}? (y/N): `)).trim().toLowerCase();
rl.close();
if (confirm !== 'y' && confirm !== 'yes') throw new Error('Cancelled. Nothing was changed.');

if (next !== pkg.version) run('npm', ['version', next, '--no-git-tag-version']);
console.log(`Publishing ${pkg.name}@${next}...`);
run('npm', ['publish', '--access', 'public', '--registry', registry]);
console.log('Published. Verify with: npm view @dipanshuhandoo/fetchforge version');
