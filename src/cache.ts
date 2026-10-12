import {
  isCircuitOpenError,
  isHttpError,
  isNetworkError,
  isRateLimitError,
  isTimeoutError,
  isValidationError,
} from './errors.ts';
import {
  cachePartitionProviderCount,
  getCachePartitions,
  isCacheNeutral,
  getRequestResponseType,
  setRevalidating,
  withTimeout,
} from './internal.ts';
import type { Store } from './store.ts';
import { memoryStore } from './stores.ts';
import type { CacheStatus, FetchResult, HookRequest, Middleware, Plugin } from './types.ts';
import { buildUrl, isPlainObject } from './utils.ts';

/** Per-request cache control, passed as `meta: { cache: ... }`. `false` bypasses the cache entirely. */
export interface RequestCacheOptions {
  /** Freshness in ms; overrides Cache-Control and the plugin default. */
  ttl?: number;
  staleWhileRevalidate?: number;
  staleIfError?: number;
  /** Labels for group invalidation with `invalidateTag()`. */
  tags?: string[];
  /** Replaces the computed cache key. */
  key?: string;
  /** `'reload'`: skip the cache and store the fresh response. `'no-cache'`: always revalidate first. */
  force?: 'reload' | 'no-cache';
  /** On a successful mutation, invalidate these tags. */
  invalidateTags?: string[];
}

export type CacheEvent =
  | { type: 'hit' | 'stale' | 'revalidated' | 'miss'; key: string; url: string }
  | { type: 'stale-if-error'; key: string; url: string; error: unknown }
  | { type: 'store'; key: string; url: string; ttl: number }
  | { type: 'skip'; key: string; url: string; reason: CacheSkipReason }
  | { type: 'bypass'; url: string }
  | { type: 'revalidate-error'; key: string; url: string; error: unknown }
  | { type: 'invalidate'; keys: string[] };

export type CacheSkipReason =
  | 'status'
  | 'no-store'
  | 'private'
  | 'authorization'
  | 'vary'
  | 'data'
  | 'size'
  | 'expired'
  | 'should-cache';

export interface CacheStats {
  hits: number;
  stale: number;
  revalidated: number;
  misses: number;
  stores: number;
  bypassed: number;
  storeErrors: number;
}

export interface CacheOptions {
  /** Where entries live. Default: `memoryStore({ maxEntries: 500 })`. See `@dipanshuhandoo/fetchforge/stores`. */
  store?: Store;
  /** Freshness when the response has no Cache-Control/Expires (or `respectCacheControl` is false), ms. Default 60000. */
  ttl?: number;
  /** After going stale, serve the stale entry instantly and refresh in the background for this long, ms. Default 0. */
  staleWhileRevalidate?: number;
  /** After going stale, serve the stale entry when the origin fails (network, timeout, 5xx), ms. Default 0. */
  staleIfError?: number;
  /**
   * Keep entries that carry an `ETag`/`Last-Modified` this long after they are stored, ms, so a stale entry can be
   * revalidated with a cheap `304` instead of a full download. 0 keeps them only for their fresh/stale windows.
   * Default 3600000 (1 hour).
   */
  revalidationWindow?: number;
  /** Honour response Cache-Control, Expires and Vary, and request `Cache-Control: no-store/no-cache`. Default true. */
  respectCacheControl?: boolean;
  /**
   * Shared cache (one store serving many users, e.g. Redis behind a BFF). Skips `private` responses and requests with
   * `Authorization` unless the response is explicitly `public`/`s-maxage`, and prefers `s-maxage`. Default false.
   */
  shared?: boolean;
  /** Cached methods. Default `['GET']`. */
  methods?: string[];
  /** Cached statuses. Default `[200, 203, 204]`. */
  statuses?: number[];
  /** Request headers that create separate entries, e.g. `['accept-language']`. */
  vary?: string[];
  /** Custom cache key. Disables URL-based invalidation for these entries; use tags instead. */
  key?: (request: HookRequest) => string;
  /** Namespace for keys inside the store. Default `''`. */
  prefix?: string;
  /**
   * After a successful non-cached request (POST/PUT/PATCH/DELETE), invalidate the same URL and its parent
   * collection (`PATCH /todos/5` invalidates `/todos/5` and `/todos`). Or a function returning what to invalidate.
   * Default true.
   */
  invalidateOnMutation?:
    | boolean
    | ((request: HookRequest, result: FetchResult) => { urls?: string[]; tags?: string[] } | undefined);
  /** Final say on whether a successful response is stored. */
  shouldCache?: (result: FetchResult, request: HookRequest) => boolean;
  /** Skip entries whose JSON size exceeds this many characters. Default: no limit. */
  maxEntrySize?: number;
  /** Treat a store call slower than this as a miss/no-op, ms (0 disables). Default 1000. */
  storeTimeout?: number;
  onEvent?: (event: CacheEvent) => void;
  /** Store failures never fail requests; they are reported here. */
  onStoreError?: (error: unknown, operation: 'get' | 'set' | 'delete' | 'keys' | 'clear') => void;
}

export interface CachePlugin extends Plugin {
  /** Removes the entries for a URL (resolved against `baseUrl`, including query variants unless it has a query). */
  invalidate(target: string | RegExp | ((url: string) => boolean)): Promise<number>;
  /** Invalidates every entry stored with this tag. */
  invalidateTag(...tags: string[]): Promise<void>;
  clear(): Promise<void>;
  stats(): CacheStats;
  /** Resolves when background revalidations have finished, e.g. before shutdown or in tests. */
  whenIdle(): Promise<void>;
}

interface CacheEntry {
  v: 1;
  data?: unknown;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  finalUrl: string;
  redirected: boolean;
  storedAt: number;
  freshUntil: number;
  swrUntil: number;
  sifUntil: number;
  vary?: Record<string, string>;
  tags?: Record<string, string>;
}

interface Times {
  fresh: number;
  swr: number;
  sif: number;
}

const VARY_SEP = '|vary|';
const TAG_SEGMENT = '~tag:';
const PRIVATE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const NOT_MERGED_ON_304 = new Set([
  'content-length',
  'content-encoding',
  'content-type',
  'transfer-encoding',
]);

function parseCacheControl(value: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!value) return out;
  for (const part of value.split(',')) {
    const [name = '', ...rest] = part.split('=');
    const key = name.trim().toLowerCase();
    if (key) out.set(key, rest.join('=').trim().replace(/^"|"$/g, ''));
  }
  return out;
}

const seconds = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value) * 1000;
};

function isJsonSafe(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const ok = Array.isArray(value)
    ? value.every((item) => isJsonSafe(item, seen))
    : isPlainObject(value) &&
      Object.values(value).every((item) => item === undefined || isJsonSafe(item, seen));
  seen.delete(value);
  return ok;
}

function isEntry(value: unknown): value is CacheEntry {
  return (
    isPlainObject(value) && value.v === 1 && typeof value.status === 'number' && isPlainObject(value.headers)
  );
}

function checkMs(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== 'number' || !(value >= 0))) {
    throw new RangeError(`cache: ${name} must be a number >= 0`);
  }
}

function readRequestOptions(value: unknown): RequestCacheOptions | false | undefined {
  if (value === false || value === undefined) return value;
  if (!isPlainObject(value)) throw new TypeError('meta.cache must be false or an object');
  return value as RequestCacheOptions;
}

async function fingerprint(values: string[]): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/**
 * HTTP response cache with TTL, stale-while-revalidate, stale-if-error, ETag/Last-Modified revalidation, tags and
 * mutation invalidation, on a pluggable store (memory, Web Storage, IndexedDB, Redis, cache-bridge, files).
 * Register it first so cache hits skip the other plugins.
 */
export function cache(options: CacheOptions = {}): CachePlugin {
  const store: Store = options.store ?? memoryStore({ maxEntries: 500 });
  if (
    typeof store?.get !== 'function' ||
    typeof store.set !== 'function' ||
    typeof store.delete !== 'function'
  ) {
    throw new TypeError('cache: store must implement get, set and delete');
  }
  for (const name of [
    'ttl',
    'staleWhileRevalidate',
    'staleIfError',
    'revalidationWindow',
    'storeTimeout',
    'maxEntrySize',
  ] as const) {
    checkMs(options[name], name);
  }
  const defaults: Times = {
    fresh: options.ttl ?? 60000,
    swr: options.staleWhileRevalidate ?? 0,
    sif: options.staleIfError ?? 0,
  };
  const respect = options.respectCacheControl ?? true;
  const shared = options.shared ?? false;
  const methods = new Set((options.methods ?? ['GET']).map((m) => m.toUpperCase()));
  const statuses = new Set(options.statuses ?? [200, 203, 204]);
  const varyNames = (options.vary ?? []).map((name) => name.toLowerCase());
  const prefix = options.prefix ?? '';
  const storeTimeout = options.storeTimeout ?? 1000;
  const revalidationWindow = options.revalidationWindow ?? 3600000;
  const invalidateOnMutation = options.invalidateOnMutation ?? true;
  const refreshing = new Map<string, Promise<void>>();
  const counters: CacheStats = {
    hits: 0,
    stale: 0,
    revalidated: 0,
    misses: 0,
    stores: 0,
    bypassed: 0,
    storeErrors: 0,
  };
  let baseUrl: string | undefined;

  const emit = (event: CacheEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observers must not affect requests.
    }
  };
  const storeFailed = (error: unknown, operation: 'get' | 'set' | 'delete' | 'keys' | 'clear') => {
    counters.storeErrors++;
    try {
      options.onStoreError?.(error, operation);
    } catch {
      // Observers must not affect requests.
    }
  };
  const guarded = async <T>(
    operation: 'get' | 'set' | 'delete' | 'keys',
    action: () => unknown,
    fallback: T,
  ): Promise<T> => {
    try {
      return (await withTimeout(Promise.resolve().then(action), storeTimeout, () => {
        storeFailed(new Error(`cache: store ${operation} timed out after ${storeTimeout}ms`), operation);
        return fallback;
      })) as T;
    } catch (error) {
      storeFailed(error, operation);
      return fallback;
    }
  };
  const read = (key: string) => guarded<unknown>('get', () => store.get(key), undefined);
  const write = (key: string, value: unknown, ttl?: number) =>
    guarded('set', () => store.set(key, value, ttl), undefined);
  const remove = (key: string) => guarded('delete', () => store.delete(key), undefined);
  const listKeys = async (): Promise<string[] | undefined> => {
    if (typeof store.keys !== 'function') return undefined;
    const keys = await guarded<Iterable<string> | undefined>('keys', () => store.keys?.(), undefined);
    return keys ? Array.from(keys) : undefined;
  };

  const urlKey = (method: string, url: string) => `${prefix}${method} ${url}`;
  const tagKey = (tag: string) => `${prefix}${TAG_SEGMENT}${tag}`;
  const keyFor = async (
    request: HookRequest,
    per: RequestCacheOptions | undefined,
    client: import('./client.ts').FetchClient,
  ): Promise<string | undefined> => {
    const explicitKey = per?.key !== undefined || options.key !== undefined;
    let key: string;
    if (per?.key !== undefined) key = prefix + per.key;
    else if (options.key) key = prefix + options.key(request);
    else key = urlKey(request.method, request.url);
    const responseType = getRequestResponseType(request);
    if (responseType !== 'auto' || (!explicitKey && varyNames.length > 0)) {
      let suffix = `responseType=${encodeURIComponent(responseType)}`;
      if (!explicitKey) {
        const vary = varyNames
          .map((name) => {
            const value = PRIVATE_HEADERS.includes(name) ? '<credential>' : (request.headers.get(name) ?? '');
            return `${name}=${encodeURIComponent(value)}`;
          })
          .join('&');
        if (vary) suffix += `&${vary}`;
      }
      key += `${VARY_SEP}${suffix}`;
    }

    const hooks = client.getConfig().hooks?.beforeRequest;
    if (
      !explicitKey &&
      Array.isArray(hooks) &&
      hooks.filter((hook) => !isCacheNeutral(hook)).length > cachePartitionProviderCount(client)
    ) {
      return undefined;
    }

    const identity = PRIVATE_HEADERS.flatMap((name) => {
      const value = request.headers.get(name);
      return value === null ? [] : [`header:${name}:${value}`];
    });
    let partitions: string[];
    try {
      partitions = await getCachePartitions(client, request);
    } catch {
      return undefined;
    }
    identity.push(...partitions.filter(Boolean).map((value) => `plugin:${value}`));
    if (identity.length === 0) return key;
    const hash = await fingerprint(identity);
    if (!hash) return undefined;
    return `${key}${key.includes(VARY_SEP) ? '&' : VARY_SEP}identity=${hash}`;
  };
  const parseKey = (key: string): { method: string; url: string } | undefined => {
    if (!key.startsWith(prefix) || key.startsWith(prefix + TAG_SEGMENT)) return undefined;
    const rest = key.slice(prefix.length);
    const space = rest.indexOf(' ');
    if (space < 1) return undefined;
    const method = rest.slice(0, space);
    if (!methods.has(method)) return undefined;
    const url = rest.slice(space + 1).split(VARY_SEP)[0] ?? '';
    return { method, url };
  };

  const timesFor = (
    headers: Record<string, string>,
    per: RequestCacheOptions | undefined,
  ): Times | undefined => {
    const times = { ...defaults };
    if (respect) {
      const cc = parseCacheControl(headers['cache-control']);
      if (cc.has('no-store') || (shared && cc.has('private'))) return undefined;
      const maxAge = seconds(shared && cc.has('s-maxage') ? cc.get('s-maxage') : cc.get('max-age'));
      const age = seconds(headers.age) ?? 0;
      if (cc.has('no-cache')) times.fresh = 0;
      else if (maxAge !== undefined) times.fresh = Math.max(0, maxAge - age);
      else if (headers.expires !== undefined) {
        const expires = Date.parse(headers.expires);
        const date = headers.date ? Date.parse(headers.date) : Date.now();
        times.fresh = Number.isFinite(expires)
          ? Math.max(0, expires - (Number.isFinite(date) ? date : Date.now()))
          : 0;
      }
      const swr = seconds(cc.get('stale-while-revalidate'));
      const sif = seconds(cc.get('stale-if-error'));
      if (swr !== undefined) times.swr = swr;
      if (sif !== undefined) times.sif = sif;
      if (cc.has('no-cache')) times.swr = 0;
      if (cc.has('must-revalidate') || (shared && cc.has('proxy-revalidate'))) {
        times.swr = 0;
        times.sif = 0;
      }
    }
    if (per?.ttl !== undefined) times.fresh = per.ttl;
    if (per?.staleWhileRevalidate !== undefined) times.swr = per.staleWhileRevalidate;
    if (per?.staleIfError !== undefined) times.sif = per.staleIfError;
    return times;
  };

  const serve = (
    entry: CacheEntry,
    status: CacheStatus,
    request: HookRequest,
    started: number,
  ): FetchResult => {
    const headers = {
      ...entry.headers,
      age: String(Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000))),
    };
    return {
      url: request.url,
      method: request.method,
      data: entry.data,
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      statusText: entry.statusText,
      headers,
      redirected: entry.redirected,
      redirectInfo: { wasRedirected: entry.redirected, finalUrl: entry.finalUrl, originalUrl: request.url },
      response: new Response(null, { status: entry.status, statusText: entry.statusText, headers }),
      error: null,
      attempts: 0,
      durationMs: Date.now() - started,
      cache: status,
    };
  };

  const load = async (key: string, request: HookRequest): Promise<CacheEntry | undefined> => {
    const entry = await read(key);
    if (!isEntry(entry)) return undefined;
    if (entry.vary) {
      for (const [name, value] of Object.entries(entry.vary)) {
        if ((request.headers.get(name) ?? '') !== value) return undefined;
      }
    }
    if (entry.tags) {
      const tags = Object.entries(entry.tags);
      const current = await Promise.all(tags.map(([tag]) => read(tagKey(tag))));
      if (tags.some(([, version], i) => current[i] !== version)) {
        await remove(key);
        return undefined;
      }
    }
    return entry;
  };

  const tagVersions = async (tags: string[] | undefined): Promise<Record<string, string> | undefined> => {
    if (!tags || tags.length === 0) return undefined;
    const out: Record<string, string> = {};
    await Promise.all(
      tags.map(async (tag) => {
        const existing = await read(tagKey(tag));
        if (typeof existing === 'string') {
          out[tag] = existing;
          return;
        }
        // Record a version even for new tags, so an evicted tag key never makes old entries look valid.
        const version = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
        await write(tagKey(tag), version);
        out[tag] = version;
      }),
    );
    return out;
  };

  const persist = async (key: string, entry: CacheEntry, request: HookRequest): Promise<boolean> => {
    const hasValidators = entry.headers.etag !== undefined || entry.headers['last-modified'] !== undefined;
    const keepUntil = Math.max(
      entry.freshUntil,
      entry.swrUntil,
      entry.sifUntil,
      hasValidators ? entry.storedAt + revalidationWindow : 0,
    );
    const ttl = keepUntil - entry.storedAt;
    if (ttl <= 0) {
      emit({ type: 'skip', key, url: request.url, reason: 'expired' });
      return false;
    }
    if (options.maxEntrySize !== undefined && JSON.stringify(entry).length > options.maxEntrySize) {
      emit({ type: 'skip', key, url: request.url, reason: 'size' });
      return false;
    }
    await write(key, entry, ttl);
    counters.stores++;
    emit({ type: 'store', key, url: request.url, ttl });
    return true;
  };

  const storeResult = async (
    key: string,
    request: HookRequest,
    per: RequestCacheOptions | undefined,
    result: FetchResult,
  ): Promise<void> => {
    const skip = (reason: CacheSkipReason) => emit({ type: 'skip', key, url: request.url, reason });
    if (result.error || !statuses.has(result.status)) return skip('status');
    if (options.shouldCache && !options.shouldCache(result, request)) return skip('should-cache');
    const cc = parseCacheControl(result.headers['cache-control']);
    if (respect && cc.has('no-store')) return skip('no-store');
    if (respect && shared && cc.has('private')) return skip('private');
    if (
      shared &&
      request.headers.has('authorization') &&
      !(cc.has('public') || cc.has('s-maxage') || cc.has('must-revalidate'))
    ) {
      return skip('authorization');
    }
    const varyHeader = respect ? result.headers.vary : undefined;
    const varyList = varyHeader
      ? varyHeader
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      : [];
    if (varyList.includes('*')) return skip('vary');
    if (result.data !== undefined && !isJsonSafe(result.data)) return skip('data');
    const times = timesFor(result.headers, per);
    if (!times) return skip('no-store');
    const now = Date.now();
    const { age: _age, ...headers } = result.headers;
    const entry: CacheEntry = {
      v: 1,
      status: result.status,
      statusText: result.statusText,
      headers,
      finalUrl: result.redirectInfo.finalUrl,
      redirected: result.redirected,
      storedAt: now,
      freshUntil: now + times.fresh,
      swrUntil: now + times.fresh + times.swr,
      sifUntil: now + times.fresh + times.sif,
    };
    if (result.data !== undefined) entry.data = result.data;
    if (varyList.length > 0) {
      entry.vary = Object.fromEntries(
        varyList
          .filter((name) => !PRIVATE_HEADERS.includes(name))
          .map((name) => [name, request.headers.get(name) ?? '']),
      );
    }
    const tags = await tagVersions(per?.tags);
    if (tags) entry.tags = tags;
    await persist(key, entry, request);
  };

  const refresh = async (
    key: string,
    entry: CacheEntry,
    request: HookRequest,
    per: RequestCacheOptions | undefined,
    headers: Record<string, string>,
    started: number,
  ): Promise<FetchResult> => {
    const merged = { ...entry.headers };
    for (const [name, value] of Object.entries(headers))
      if (!NOT_MERGED_ON_304.has(name)) merged[name] = value;
    const times = timesFor(merged, per);
    delete merged.age;
    const now = Date.now();
    const updated: CacheEntry = { ...entry, headers: merged, storedAt: now };
    if (times) {
      updated.freshUntil = now + times.fresh;
      updated.swrUntil = now + times.fresh + times.swr;
      updated.sifUntil = now + times.fresh + times.sif;
      await persist(key, updated, request);
    } else {
      await remove(key);
    }
    counters.revalidated++;
    emit({ type: 'revalidated', key, url: request.url });
    return serve(updated, 'revalidated', request, started);
  };

  const canServeStale = (entry: CacheEntry, error: unknown): boolean =>
    Date.now() < entry.sifUntil &&
    (isNetworkError(error) ||
      isTimeoutError(error) ||
      isCircuitOpenError(error) ||
      isRateLimitError(error) ||
      isValidationError(error) ||
      (isHttpError(error) && error.status >= 500));

  const fromNetwork = async (
    key: string,
    request: HookRequest,
    per: RequestCacheOptions | undefined,
    entry: CacheEntry | undefined,
    next: () => Promise<FetchResult>,
    started: number,
  ): Promise<FetchResult> => {
    const etag = entry?.headers.etag;
    const lastModified = entry?.headers['last-modified'];
    const added: string[] = [];
    if (entry && (etag || lastModified)) {
      setRevalidating(request, true);
      if (etag && !request.headers.has('if-none-match')) {
        request.headers.set('if-none-match', etag);
        added.push('if-none-match');
      }
      if (lastModified && !request.headers.has('if-modified-since')) {
        request.headers.set('if-modified-since', lastModified);
        added.push('if-modified-since');
      }
    }
    let result: FetchResult;
    try {
      result = await next();
    } catch (error) {
      if (entry && isHttpError(error) && error.status === 304) {
        return refresh(key, entry, request, per, error.headers, started);
      }
      if (entry && canServeStale(entry, error)) {
        counters.stale++;
        emit({ type: 'stale-if-error', key, url: request.url, error });
        return serve(entry, 'stale', request, started);
      }
      throw error;
    } finally {
      setRevalidating(request, false);
      for (const name of added) request.headers.delete(name);
    }
    if (entry && result.status === 304) return refresh(key, entry, request, per, result.headers, started);
    if (entry && result.error && result.status >= 500 && canServeStale(entry, result.error)) {
      counters.stale++;
      emit({ type: 'stale-if-error', key, url: request.url, error: result.error });
      return serve(entry, 'stale', request, started);
    }
    counters.misses++;
    emit({ type: 'miss', key, url: request.url });
    await storeResult(key, request, per, result);
    return { ...result, cache: 'miss' };
  };

  const revalidateInBackground = (
    key: string,
    request: HookRequest,
    per: RequestCacheOptions | undefined,
    entry: CacheEntry,
    next: () => Promise<FetchResult>,
  ): void => {
    if (refreshing.has(key)) return;
    const task = fromNetwork(key, request, per, entry, next, Date.now()).then(
      () => undefined,
      (error) => emit({ type: 'revalidate-error', key, url: request.url, error }),
    );
    refreshing.set(
      key,
      task.finally(() => refreshing.delete(key)),
    );
  };

  const invalidateKeys = async (keys: string[]): Promise<number> => {
    const unique = [...new Set(keys)];
    await Promise.all(unique.map(remove));
    if (unique.length > 0) emit({ type: 'invalidate', keys: unique });
    return unique.length;
  };

  const invalidateUrls = async (urls: string[]): Promise<number> => {
    const targets = urls.map((url) => {
      const hasQuery = url.includes('?');
      return { url, hasQuery };
    });
    const exact = targets.flatMap(({ url }) => [...methods].map((method) => urlKey(method, url)));
    const all = await listKeys();
    const matched = (all ?? []).filter((key) => {
      const parsed = parseKey(key);
      if (!parsed) return false;
      return targets.some(({ url, hasQuery }) =>
        hasQuery ? parsed.url === url : parsed.url === url || parsed.url.split('?')[0] === url,
      );
    });
    return invalidateKeys([...exact, ...matched]);
  };

  const invalidateTags = async (tags: string[]): Promise<void> => {
    await Promise.all(
      tags.map((tag) =>
        write(tagKey(tag), `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`),
      ),
    );
    if (tags.length > 0) emit({ type: 'invalidate', keys: tags.map(tagKey) });
  };

  const resolveUrl = (target: string): string => {
    try {
      return buildUrl(target, baseUrl, undefined, { method: 'GET', url: target });
    } catch {
      return target;
    }
  };

  const afterMutation = async (
    request: HookRequest,
    per: RequestCacheOptions | undefined,
    result: FetchResult,
  ): Promise<void> => {
    if (result.error || !result.ok) return;
    const tags = [...(per?.invalidateTags ?? [])];
    const urls: string[] = [];
    if (typeof invalidateOnMutation === 'function') {
      const extra = invalidateOnMutation(request, result);
      if (extra?.urls) urls.push(...extra.urls.map(resolveUrl));
      if (extra?.tags) tags.push(...extra.tags);
    } else if (invalidateOnMutation) {
      const url = new URL(request.url);
      url.search = '';
      url.hash = '';
      urls.push(url.href);
      const path = url.pathname.replace(/\/+$/, '');
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent !== '') {
        url.pathname = parent;
        urls.push(url.href);
      }
    }
    await Promise.all([urls.length > 0 ? invalidateUrls(urls) : undefined, invalidateTags(tags)]);
  };

  const middleware: Middleware = async ({ request, client }, next) => {
    const started = Date.now();
    const per = readRequestOptions(request.meta.cache);
    if (per === false) {
      counters.bypassed++;
      emit({ type: 'bypass', url: request.url });
      return next();
    }
    if (!methods.has(request.method)) {
      const result = await next();
      await afterMutation(request, per, result);
      return result;
    }
    if (getRequestResponseType(request) === 'stream') {
      counters.bypassed++;
      emit({ type: 'bypass', url: request.url });
      return next();
    }
    const requested = respect
      ? parseCacheControl(request.headers.get('cache-control'))
      : new Map<string, string>();
    if (requested.has('no-store')) {
      counters.bypassed++;
      emit({ type: 'bypass', url: request.url });
      return next();
    }
    const key = await keyFor(request, per, client);
    if (key === undefined) {
      counters.bypassed++;
      emit({
        type: 'skip',
        key: urlKey(request.method, request.url),
        url: request.url,
        reason: 'authorization',
      });
      return next();
    }
    if (per?.force === 'reload') return fromNetwork(key, request, per, undefined, next, started);
    const entry = await load(key, request);
    if (!entry) return fromNetwork(key, request, per, undefined, next, started);
    const now = Date.now();
    const mustRevalidate =
      per?.force === 'no-cache' || requested.has('no-cache') || requested.get('max-age') === '0';
    if (!mustRevalidate && now < entry.freshUntil) {
      counters.hits++;
      emit({ type: 'hit', key, url: request.url });
      return serve(entry, 'hit', request, started);
    }
    if (!mustRevalidate && now < entry.swrUntil) {
      counters.stale++;
      emit({ type: 'stale', key, url: request.url });
      revalidateInBackground(key, request, per, entry, next);
      return serve(entry, 'stale', request, started);
    }
    return fromNetwork(key, request, per, entry, next, started);
  };

  return {
    name: 'cache',
    middleware,
    setup(client) {
      baseUrl = client.getConfig().baseUrl;
    },
    invalidate(target) {
      if (typeof target === 'string') return invalidateUrls([resolveUrl(target)]);
      if (!(target instanceof RegExp) && typeof target !== 'function') {
        throw new TypeError('cache.invalidate expects a URL, a RegExp or a function');
      }
      if (typeof store.keys !== 'function') {
        throw new TypeError('cache.invalidate(RegExp | function) needs a store that implements keys()');
      }
      const test = target instanceof RegExp ? (url: string) => target.test(url) : target;
      return listKeys().then((keys) =>
        invalidateKeys(
          (keys ?? []).filter((key) => {
            const parsed = parseKey(key);
            return parsed !== undefined && test(parsed.url);
          }),
        ),
      );
    },
    invalidateTag: (...tags) => invalidateTags(tags),
    async clear() {
      if (prefix !== '' && typeof store.keys === 'function') {
        const keys = (await listKeys()) ?? [];
        await Promise.all(keys.filter((key) => key.startsWith(prefix)).map(remove));
        return;
      }
      if (typeof store.clear !== 'function')
        throw new TypeError('cache.clear() needs a store that implements clear()');
      try {
        await store.clear();
      } catch (error) {
        storeFailed(error, 'clear');
        throw error;
      }
    },
    stats: () => ({ ...counters }),
    async whenIdle() {
      while (refreshing.size > 0) await Promise.allSettled([...refreshing.values()]);
    },
  };
}
