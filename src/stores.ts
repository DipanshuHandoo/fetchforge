import type { Store } from './store.ts';

export type { Store } from './store.ts';

const expiry = (ttlMs: number | undefined): number =>
  ttlMs !== undefined && ttlMs > 0 && Number.isFinite(ttlMs) ? Date.now() + ttlMs : 0;
const expired = (at: number): boolean => at !== 0 && at <= Date.now();

function checkPrefix(prefix: unknown, name: string): string {
  if (typeof prefix !== 'string') throw new TypeError(`${name}: prefix must be a string`);
  return prefix;
}

/** Store returned by `webStorageStore()`. */
export interface WebStorageStore<V = unknown> extends Store<V> {
  clear(): void;
  keys(): string[];
  /** Removes expired entries now (they are otherwise removed when read). */
  purgeExpired(): void;
}

/** Store returned by `indexedDbStore()`. */
export interface IndexedDbStore<V = unknown> extends Store<V> {
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  /** Closes the connection; the next call reopens it. */
  close(): void;
}

/** Store returned by `redisStore()`. */
export interface RedisStore<V = unknown> extends Store<V> {
  /** Deletes every key under the prefix (SCAN + DEL in batches); refuses to run with an empty prefix. */
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

/** Store returned by `cacheBridgeStore()`. */
export interface CacheBridgeStore<V = unknown> extends Store<V> {
  clear(): Promise<void>;
  keys(): string[];
}

// ---- memory -------------------------------------------------------------------------------

export interface MemoryStoreOptions {
  /** Least-recently-used entries are evicted beyond this count. Default 1000. */
  maxEntries?: number;
  /** `structuredClone` values on write and read so callers cannot mutate cached data. Default false. */
  clone?: boolean;
}

export interface MemoryStore<V = unknown> extends Store<V> {
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs?: number): void;
  delete(key: string): boolean;
  clear(): void;
  keys(): string[];
  /** Live and not-yet-purged entries. */
  readonly size: number;
}

/** In-process LRU store with per-entry TTL. Works in every runtime; data is lost on restart. */
export function memoryStore<V = unknown>(options: MemoryStoreOptions = {}): MemoryStore<V> {
  const max = options.maxEntries ?? 1000;
  if (!Number.isInteger(max) || max < 1)
    throw new RangeError('memoryStore: maxEntries must be an integer >= 1');
  const copy = options.clone ? (value: V): V => structuredClone(value) : (value: V): V => value;
  const map = new Map<string, { value: V; expires: number }>();

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (expired(entry.expires)) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, entry);
      return copy(entry.value);
    },
    set(key, value, ttlMs) {
      map.delete(key);
      map.set(key, { value: copy(value), expires: expiry(ttlMs) });
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    keys() {
      const out: string[] = [];
      for (const [key, entry] of map) {
        if (expired(entry.expires)) map.delete(key);
        else out.push(key);
      }
      return out;
    },
    get size() {
      return map.size;
    },
  };
}

// ---- Web Storage ----------------------------------------------------------------------------

/** The subset of the DOM `Storage` interface used (localStorage, sessionStorage or a polyfill). */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebStorageStoreOptions {
  /** Namespaces keys so `clear()` only removes this store's entries. Default `'fetchforge:'`. */
  prefix?: string;
}

/**
 * Persists JSON-serialisable values in `localStorage` (survives reloads) or `sessionStorage` (per tab).
 * When the quota is exceeded, expired entries are purged and the write retried once; then it throws.
 */
export function webStorageStore<V = unknown>(
  storage: StorageLike,
  options: WebStorageStoreOptions = {},
): WebStorageStore<V> {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('webStorageStore requires a Storage object such as localStorage');
  }
  const prefix = checkPrefix(options.prefix ?? 'fetchforge:', 'webStorageStore');
  const ownKeys = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) out.push(key);
    }
    return out;
  };
  const read = (full: string): { v: V; e: number } | undefined => {
    const raw = storage.getItem(full);
    if (raw === null) return undefined;
    try {
      const parsed = JSON.parse(raw) as { v: V; e: number };
      if (!expired(parsed.e)) return parsed;
    } catch {
      // Corrupt or foreign value: drop it.
    }
    storage.removeItem(full);
    return undefined;
  };
  const purgeExpired = () => {
    for (const key of ownKeys()) read(key);
  };

  return {
    get: (key) => read(prefix + key)?.v,
    set(key, value, ttlMs) {
      const payload = JSON.stringify({ v: value, e: expiry(ttlMs) });
      try {
        storage.setItem(prefix + key, payload);
      } catch {
        purgeExpired();
        storage.setItem(prefix + key, payload);
      }
    },
    delete: (key) => storage.removeItem(prefix + key),
    clear() {
      for (const key of ownKeys()) storage.removeItem(key);
    },
    keys() {
      const out: string[] = [];
      for (const key of ownKeys()) if (read(key)) out.push(key.slice(prefix.length));
      return out;
    },
    purgeExpired,
  };
}

// ---- IndexedDB ------------------------------------------------------------------------------

export interface IndexedDbStoreOptions {
  /** Database name; use different names for independent stores. Default `'fetchforge'`. */
  dbName?: string;
  /** Defaults to `globalThis.indexedDB`. Pass one explicitly in workers or tests. */
  indexedDB?: IDBFactory;
}

const IDB_STORE = 'entries';

/**
 * Browser store backed by IndexedDB: large quotas, structured-clone values (Dates, Maps, typed arrays),
 * survives reloads. The connection opens lazily and closes itself when another tab upgrades the database.
 */
export function indexedDbStore<V = unknown>(options: IndexedDbStoreOptions = {}): IndexedDbStore<V> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') {
    throw new TypeError('indexedDbStore: IndexedDB is not available; pass the indexedDB option');
  }
  const dbName = options.dbName ?? 'fetchforge';
  let opening: Promise<IDBDatabase> | undefined;

  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IDB_STORE)) request.result.createObjectStore(IDB_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        db.onclose = () => {
          opening = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        opening = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        opening = undefined;
        reject(new Error(`indexedDbStore: opening "${dbName}" is blocked by another connection`));
      };
    });
    return opening;
  };

  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const request = action(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error('indexedDbStore: transaction aborted'));
    });
  };

  return {
    async get(key) {
      const record = await run<{ v: V; e: number } | undefined>('readonly', (s) => s.get(key));
      if (!record) return undefined;
      if (expired(record.e)) {
        await run('readwrite', (s) => s.delete(key));
        return undefined;
      }
      return record.v;
    },
    async set(key, value, ttlMs) {
      await run('readwrite', (s) => s.put({ v: value, e: expiry(ttlMs) }, key));
    },
    async delete(key) {
      await run('readwrite', (s) => s.delete(key));
    },
    async clear() {
      await run('readwrite', (s) => s.clear());
    },
    async keys() {
      return (await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String);
    },
    close() {
      void opening?.then((db) => db.close()).catch(() => {});
      opening = undefined;
    },
  };
}

// ---- Redis ----------------------------------------------------------------------------------

/** ioredis (`call`) or node-redis v4/v5 (`sendCommand`) client, or anything exposing either. */
export type RedisLike =
  | { call: (command: string, ...args: string[]) => Promise<unknown> }
  | { sendCommand: (args: string[]) => Promise<unknown> };

export interface RedisStoreOptions {
  /** Key namespace; required to be non-empty for `clear()`. Default `'fetchforge:'`. */
  prefix?: string;
  /** SCAN batch size for `keys()`/`clear()`. Default 500. */
  scanCount?: number;
}

/**
 * Shared store on Redis (values JSON-encoded, TTL via `PX`). No Redis dependency: pass your connected
 * ioredis or node-redis client. Every instance of your service sees the same entries.
 */
export function redisStore<V = unknown>(client: RedisLike, options: RedisStoreOptions = {}): RedisStore<V> {
  const call = (client as { call?: unknown }).call;
  const sendCommand = (client as { sendCommand?: unknown }).sendCommand;
  let exec: (args: string[]) => Promise<unknown>;
  if (typeof call === 'function') {
    exec = (args) => call.call(client, args[0], ...args.slice(1)) as Promise<unknown>;
  } else if (typeof sendCommand === 'function') {
    exec = (args) => sendCommand.call(client, args) as Promise<unknown>;
  } else {
    throw new TypeError('redisStore requires an ioredis or node-redis client (call or sendCommand)');
  }
  const prefix = checkPrefix(options.prefix ?? 'fetchforge:', 'redisStore');
  const count = String(options.scanCount ?? 500);
  const pattern = `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`;

  const scan = async (): Promise<string[]> => {
    const out: string[] = [];
    let cursor = '0';
    do {
      const reply = (await exec(['SCAN', cursor, 'MATCH', pattern, 'COUNT', count])) as [unknown, unknown[]];
      cursor = String(reply[0]);
      for (const key of reply[1]) out.push(String(key));
    } while (cursor !== '0');
    return out;
  };

  return {
    async get(key) {
      const raw = await exec(['GET', prefix + key]);
      return raw === null || raw === undefined ? undefined : (JSON.parse(String(raw)) as V);
    },
    async set(key, value, ttlMs) {
      const json = JSON.stringify(value);
      const ttl = ttlMs !== undefined && ttlMs > 0 && Number.isFinite(ttlMs) ? Math.ceil(ttlMs) : 0;
      await exec(ttl ? ['SET', prefix + key, json, 'PX', String(ttl)] : ['SET', prefix + key, json]);
    },
    async delete(key) {
      await exec(['DEL', prefix + key]);
    },
    async clear() {
      if (prefix === '') throw new Error('redisStore: refusing to clear() without a prefix');
      const keys = await scan();
      for (let i = 0; i < keys.length; i += 500) await exec(['DEL', ...keys.slice(i, i + 500)]);
    },
    async keys() {
      return (await scan()).map((key) => key.slice(prefix.length));
    },
  };
}

// ---- cache-bridge ---------------------------------------------------------------------------

/** The subset of a `@dipanshuhandoo/cache-bridge` cache used by the adapter. */
export interface CacheBridgeLike<V = unknown> {
  getAsync(key: string): Promise<V | undefined>;
  setAsync(key: string, value: V, options?: { ttl?: number }): Promise<unknown>;
  deleteAsync(key: string): Promise<unknown>;
  clear(): void;
  keys(): string[];
  sync?(): Promise<unknown>;
}

/**
 * Adapts a `@dipanshuhandoo/cache-bridge` cache (memory L1 + optional Redis L2 with cross-instance
 * invalidation). cache-bridge is not a dependency of fetchforge; install and configure it yourself.
 * `keys()` lists the local L1 tier only.
 */
export function cacheBridgeStore<V = unknown>(cache: CacheBridgeLike<V>): CacheBridgeStore<V> {
  for (const method of ['getAsync', 'setAsync', 'deleteAsync', 'clear', 'keys'] as const) {
    if (typeof cache?.[method] !== 'function') {
      throw new TypeError(`cacheBridgeStore requires a cache-bridge cache (missing ${method}())`);
    }
  }
  return {
    get: (key) => cache.getAsync(key),
    set: (key, value, ttlMs) =>
      cache.setAsync(key, value, {
        ttl: ttlMs !== undefined && ttlMs > 0 && Number.isFinite(ttlMs) ? Math.ceil(ttlMs) : 0,
      }),
    delete: (key) => cache.deleteAsync(key),
    async clear() {
      cache.clear();
      await cache.sync?.();
    },
    keys: () => cache.keys(),
  };
}
