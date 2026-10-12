import { spawnSync } from 'node:child_process';

/** Runs a command synchronously. `npm` is resolved through npm_execpath so it works on every platform. */
export function run(command, args, { cwd, capture = false, env } = {}) {
  if (command === 'npm') {
    if (!process.env.npm_execpath) throw new Error('Run this script through an npm script (npm run <name>).');
    args = [process.env.npm_execpath, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status}): ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}
