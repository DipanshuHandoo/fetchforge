import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function lockCheckpoint(dir) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'checkpoint.lock');
  let handle;
  try {
    handle = await open(file, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Checkpoint is locked; see README for stale-lock recovery');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    await handle.close();
    await rm(file);
    throw error;
  }
  return async () => {
    await handle.close();
    await rm(file);
  };
}

export async function readCheckpoint(file, fingerprint) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      version: 1,
      fingerprint,
      cursor: null,
      pages: 0,
      records: 0,
      complete: false,
      cursors: [],
      identities: [],
    };
  }
  const value = JSON.parse(text);
  if (
    value.version !== 1 ||
    value.fingerprint !== fingerprint ||
    (value.cursor !== null && (typeof value.cursor !== 'string' || !value.cursor)) ||
    !Number.isSafeInteger(value.pages) ||
    value.pages < 0 ||
    !Number.isSafeInteger(value.records) ||
    value.records < 0 ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.cursors) ||
    value.cursors.some((cursor) => typeof cursor !== 'string' || !cursor) ||
    new Set(value.cursors).size !== value.cursors.length ||
    !Array.isArray(value.identities) ||
    value.identities.some((id) => typeof id !== 'string' || !id) ||
    new Set(value.identities).size !== value.identities.length ||
    value.records !== value.identities.length ||
    (value.complete && (value.cursor !== null || value.pages === 0)) ||
    (!value.complete && value.pages !== value.cursors.length) ||
    (value.complete && value.pages !== value.cursors.length + 1) ||
    (value.cursor !== null && value.cursors.at(-1) !== value.cursor) ||
    (!value.complete && value.pages > 0 && value.cursor === null)
  ) {
    throw new Error('Checkpoint is invalid or belongs to a different job/configuration');
  }
  return value;
}

export async function saveCheckpoint(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
