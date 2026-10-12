import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.ts';

export type { Store } from './store.ts';

export interface FileStoreOptions {
  /** Directory for cache files; created on first write. Use a dedicated directory, `clear()` empties it. */
  dir: string;
}

/** Store returned by `fileStore()`. */
export interface FileStore<V = unknown> extends Store<V> {
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  /** Deletes expired files now (they are otherwise removed when read). */
  purgeExpired(): Promise<void>;
}

interface FileRecord<V> {
  k: string;
  v: V;
  e: number;
}

/**
 * Node.js store that keeps one JSON file per key. Writes are atomic (temp file + rename), so a crash never
 * leaves a half-written entry. Suited to CLIs, build tools and single-host jobs that want a cache across runs.
 */
export function fileStore<V = unknown>(options: FileStoreOptions): FileStore<V> {
  if (!options || typeof options.dir !== 'string' || options.dir === '') {
    throw new TypeError('fileStore: dir must be a non-empty string');
  }
  const { dir } = options;
  const pathFor = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  const expired = (at: number) => at !== 0 && at <= Date.now();

  const readRecord = async (path: string): Promise<FileRecord<V> | undefined> => {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const record = JSON.parse(raw) as FileRecord<V>;
      if (!expired(record.e)) return record;
    } catch {
      // Corrupt file: remove below.
    }
    await rm(path, { force: true });
    return undefined;
  };

  const entries = async (): Promise<string[]> => {
    try {
      return (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };

  return {
    async get(key) {
      const record = await readRecord(pathFor(key));
      return record && record.k === key ? record.v : undefined;
    },
    async set(key, value, ttlMs) {
      await mkdir(dir, { recursive: true });
      const target = pathFor(key);
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      const e = ttlMs !== undefined && ttlMs > 0 && Number.isFinite(ttlMs) ? Date.now() + ttlMs : 0;
      await writeFile(temp, JSON.stringify({ k: key, v: value, e }));
      try {
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async delete(key) {
      try {
        await unlink(pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    async clear() {
      await Promise.all((await entries()).map((path) => rm(path, { force: true })));
    },
    async keys() {
      const records = await Promise.all((await entries()).map(readRecord));
      return records.filter((record) => record !== undefined).map((record) => record.k);
    },
    async purgeExpired() {
      await Promise.all((await entries()).map(readRecord));
    },
  };
}
