import { cp, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { run } from './run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

const common = {
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  bundle: true,
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
};

for (const minify of [false, true]) {
  const suffix = minify ? '.min' : '';
  await build({
    ...common,
    minify,
    format: 'esm',
    platform: 'neutral',
    outfile: `dist/esm/index${suffix}.js`,
    external: ['@dipanshuhandoo/async-slot-pool'],
  });
  await build({
    ...common,
    minify,
    format: 'cjs',
    platform: 'node',
    outfile: `dist/cjs/index${suffix}.js`,
    external: ['@dipanshuhandoo/async-slot-pool'],
  });
  await build({
    ...common,
    minify,
    format: 'iife',
    platform: 'browser',
    globalName: 'FetchForge',
    outfile: `dist/browser/fetchforge.global${suffix}.js`,
  });
}

await writeFile(new URL('../dist/cjs/package.json', import.meta.url), '{ "type": "commonjs" }\n');

run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root });
for (const name of await readdir(new URL('../dist/esm', import.meta.url))) {
  if (name.endsWith('.d.ts')) {
    await cp(
      new URL(`../dist/esm/${name}`, import.meta.url),
      new URL(`../dist/cjs/${name}`, import.meta.url),
    );
  }
}
console.log('Built ESM, CommonJS, browser bundles, source maps and declarations.');
