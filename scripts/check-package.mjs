import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 'fetchforge-'));
const listOnly = process.argv.includes('--list');

const required = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'dist/esm/index.js',
  'dist/esm/index.min.js',
  'dist/esm/index.d.ts',
  'dist/cjs/index.js',
  'dist/cjs/index.min.js',
  'dist/cjs/index.d.ts',
  'dist/cjs/package.json',
  'dist/browser/fetchforge.global.js',
  'dist/browser/fetchforge.global.min.js',
];
const forbidden =
  /(^|\/)(src|test|scripts|examples|\.github|node_modules)\/|\.env|\.tsbuildinfo$|^tsconfig|^biome/;

const exercise = `
  const { createClient, HttpError, isCircuitOpenError } = MOD;
  const server = (await import('node:http')).createServer((req, res) => {
    res.writeHead(req.url === '/bad' ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url !== '/bad' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const client = createClient({ baseUrl: base });
    const ok = await client.get('/x');
    if (ok.data.ok !== true) throw new Error('GET failed');
    const err = await client.get('/bad').catch((e) => e);
    if (!(err instanceof HttpError) || err.status !== 500) throw new Error('HttpError contract differs');
    const bulk = await client.bulk(['/a', '/b'], { concurrency: 1 });
    if (bulk.fulfilled !== 2) throw new Error('bulk failed');
    console.log('ok');
  } finally {
    server.closeAllConnections();
    server.close();
  }
`;

try {
  if (!process.argv.includes('--built')) run('npm', ['run', 'build'], { cwd: root });
  assert.equal(metadata.name, '@dipanshuhandoo/fetchforge');
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.publishConfig.access, 'public');
  assert.equal(metadata.private, undefined);

  const packing = ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary];
  packing.push(listOnly ? '--dry-run' : '--dry-run=false');
  const result = JSON.parse(run('npm', packing, { cwd: root, capture: true }));
  const packed = Array.isArray(result) ? result[0] : result[metadata.name];
  const files = packed.files.map(({ path: p }) => p);
  for (const file of required) assert.ok(files.includes(file), `tarball is missing ${file}`);
  for (const file of files) {
    if (file.endsWith('.map')) continue;
    assert.ok(!forbidden.test(file), `tarball contains unexpected file ${file}`);
  }
  assert.ok(packed.size < 400_000, `tarball is unexpectedly large: ${packed.size} bytes`);
  for (const file of files.filter((f) => f.endsWith('.map'))) {
    const map = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    assert.ok(
      map.sources.every((s) => !path.isAbsolute(s) && !/^[a-z]:/i.test(s)),
      `${file} has absolute source paths`,
    );
  }
  console.log(`Tarball allowlist passed: ${files.length} files, ${packed.size} bytes.`);
  if (listOnly) {
    console.log(files.sort().join('\n'));
  } else {
    const tarball = path.join(temporary, packed.filename);
    run(process.execPath, [path.join(root, 'node_modules/publint/src/cli.js'), tarball].filter(Boolean), {
      cwd: root,
    });
    const consumer = path.join(temporary, 'consumer');
    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(
      'npm',
      [
        'install',
        tarball,
        '--dry-run=false',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { cwd: consumer },
    );
    run(
      'npm',
      [
        'install',
        '-D',
        'typescript@^7',
        '@types/node@^24',
        '--dry-run=false',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { cwd: consumer },
    );

    const outputs = [];
    for (const subpath of ['', '/min']) {
      const specifier = JSON.stringify(metadata.name + subpath);
      const esm = `import * as MOD from ${specifier};\n${exercise}`;
      const cjs = `(async () => { const MOD = require(${specifier});\n${exercise} })().catch((e) => { console.error(e); process.exitCode = 1; });`;
      outputs.push(
        run(process.execPath, ['--input-type=module', '--eval', esm], { cwd: consumer, capture: true }),
      );
      outputs.push(
        run(process.execPath, ['--input-type=commonjs', '--eval', cjs], { cwd: consumer, capture: true }),
      );
    }
    assert.ok(outputs.every((o) => o.trim() === 'ok'));

    for (const name of await readdir(path.join(root, 'examples'))) {
      await copyFile(path.join(root, 'examples', name), path.join(consumer, name));
    }
    for (const name of ['basic', 'resilience', 'bulk'])
      run(process.execPath, [`${name}.mjs`], { cwd: consumer });

    for (const extension of ['mts', 'cts']) {
      await copyFile(
        path.join(root, 'test/types', `consumer.${extension}`),
        path.join(consumer, `consumer.${extension}`),
      );
    }
    const tsc = path.join(consumer, 'node_modules/typescript/bin/tsc');
    run(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--strict',
        '--module',
        'nodenext',
        '--target',
        'es2022',
        'consumer.mts',
        'consumer.cts',
      ],
      { cwd: consumer },
    );
    run(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--strict',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--target',
        'es2022',
        'consumer.mts',
      ],
      { cwd: consumer },
    );

    run(
      process.execPath,
      [
        path.join(root, 'node_modules/@arethetypeswrong/cli/dist/index.js'),
        tarball,
        '--profile',
        'node16',
        '--exclude-entrypoints',
        'browser',
      ],
      { cwd: root },
    );
    console.log(
      'Packed package: ESM, CommonJS, /min, TypeScript (nodenext, bundler), examples, publint and attw passed.',
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
