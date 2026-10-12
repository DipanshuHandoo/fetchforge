import { isHttpError, isNetworkError, QueuedError } from './errors.ts';
import { randomId } from './internal.ts';
import { type Messages, resolveMessage } from './messages.ts';
import type { Store } from './store.ts';
import { memoryStore, webStorageStore } from './stores.ts';
import type { FetchResult, HookRequest, Middleware, Plugin } from './types.ts';

/** A request saved for replay. Bodies are kept as strings (JSON and text). */
export interface QueuedRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  meta?: Record<string, unknown>;
  queuedAt: number;
  attempts: number;
}

export type OfflineDropReason = 'expired' | 'rejected' | 'max-attempts';

export interface OfflineQueueOptions {
  /**
   * Where the queue persists. Default: `localStorage` when available (survives reloads), otherwise memory.
   * Only one key (`'queue'`) is used, so any `Store` works.
   */
  store?: Store;
  /** Methods that may be queued. Default POST, PUT, PATCH, DELETE. */
  methods?: string[];
  /** Default: `navigator.onLine` (true when unavailable, e.g. in Node.js). */
  isOnline?: () => boolean;
  /** Which failures queue the request. Default: network errors (no response at all). */
  queueOn?: (error: unknown, request: HookRequest) => boolean;
  /** Replay strictly in order, stopping at the first item that fails. Default true. */
  preserveOrder?: boolean;
  /** When full, new requests are not queued and fail normally. Default 100. */
  maxItems?: number;
  /** Items older than this are dropped instead of replayed, ms. Default 86400000 (24h). */
  maxAge?: number;
  /** Replay attempts per item before it is dropped. Default 5. */
  maxAttempts?: number;
  /** Background replay interval, ms (0 disables). The timer is unref'd. Default 30000. */
  replayInterval?: number;
  /** Headers not persisted (hooks such as `bearerAuth` add fresh ones on replay). */
  omitHeaders?: string[];
  /** `'throw'` (default) rejects with `QueuedError`; `'resolve'` resolves a 202 result with `queued` set. */
  mode?: 'throw' | 'resolve';
  onQueued?: (item: QueuedRequest) => void;
  onReplay?: (item: QueuedRequest, result: FetchResult) => void;
  onDrop?: (item: QueuedRequest, reason: OfflineDropReason, error?: unknown) => void;
}

export interface OfflineFlushResult {
  sent: number;
  dropped: number;
  remaining: number;
}

export interface OfflineQueuePlugin extends Plugin {
  /** Replays queued requests now (single-flight; other tabs skip while one replays). */
  flush(): Promise<OfflineFlushResult>;
  pending(): Promise<QueuedRequest[]>;
  clear(): Promise<void>;
  /** Stops the replay timer and the `online` listener. */
  stop(): void;
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

const QUEUE_KEY = 'queue';
const LOCK_NAME = 'fetchforge-offline-queue';

function copyQueuedRequest(item: QueuedRequest): QueuedRequest {
  return {
    ...item,
    headers: { ...item.headers },
    ...(item.meta ? { meta: JSON.parse(JSON.stringify(item.meta)) as Record<string, unknown> } : {}),
  };
}

function defaultStore(): Store {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) return webStorageStore(storage, { prefix: 'fetchforge-offline:' });
  } catch {
    // Access to localStorage can throw (sandboxed iframes, disabled storage).
  }
  return memoryStore();
}

/**
 * Queues mutations made while offline (or that fail with a network error) and replays them when the connection
 * returns: on the browser `online` event, on a timer, or when you call `flush()`. Replays go through the client,
 * so auth, idempotency and cache invalidation apply. Pair with `idempotency()` so a replay is never applied twice.
 */
export function offlineQueue(options: OfflineQueueOptions = {}): OfflineQueuePlugin {
  const store = options.store ?? defaultStore();
  const methods = new Set(
    (options.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).map((m) => m.toUpperCase()),
  );
  const isOnline =
    options.isOnline ??
    (() => (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine ?? true);
  const queueOn = options.queueOn ?? ((error: unknown) => isNetworkError(error));
  const preserveOrder = options.preserveOrder ?? true;
  const maxItems = options.maxItems ?? 100;
  const maxAge = options.maxAge ?? 86400000;
  const maxAttempts = options.maxAttempts ?? 5;
  const replayInterval = options.replayInterval ?? 30000;
  const omit = new Set(
    (options.omitHeaders ?? ['authorization', 'cookie', 'proxy-authorization']).map((h) => h.toLowerCase()),
  );
  const mode = options.mode ?? 'throw';
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;

  let client: import('./client.ts').FetchClient | undefined;
  let messages: Partial<Messages> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let removeListener: (() => void) | undefined;
  let flushing: Promise<OfflineFlushResult> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const notify = <A extends unknown[]>(callback: ((...args: A) => void) | undefined, ...args: A) => {
    try {
      callback?.(...args);
    } catch {
      // Observers must not affect requests.
    }
  };

  const load = async (): Promise<QueuedRequest[]> => {
    const value = await store.get(QUEUE_KEY);
    return Array.isArray(value) ? (value as QueuedRequest[]) : [];
  };

  /** Serialised read-modify-write, also across tabs when the Web Locks API exists. */
  const mutate = <T>(
    change: (items: QueuedRequest[]) => { items: QueuedRequest[]; value: T },
  ): Promise<T> => {
    const run = async () => {
      const work = async () => {
        const { items, value } = change(await load());
        await store.set(QUEUE_KEY, items);
        return value;
      };
      return locks ? locks.request(LOCK_NAME, work) : work();
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };

  const enqueue = async (request: HookRequest, started: number): Promise<FetchResult | undefined> => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (!omit.has(name)) headers[name] = value;
    });
    const item: QueuedRequest = {
      id: randomId(),
      url: request.url,
      method: request.method,
      headers,
      queuedAt: Date.now(),
      attempts: 0,
    };
    if (typeof request.body === 'string') item.body = request.body;
    const { offline: _offline, ...meta } = request.meta;
    if (Object.keys(meta).length > 0) item.meta = JSON.parse(JSON.stringify(meta)) as Record<string, unknown>;
    const added = await mutate((items) =>
      items.length >= maxItems ? { items, value: false } : { items: [...items, item], value: true },
    );
    if (!added) return undefined;
    notify(options.onQueued, copyQueuedRequest(item));
    ensureTimer();
    const ctx = { method: request.method, url: request.url };
    if (mode === 'resolve') {
      return {
        url: request.url,
        method: request.method,
        data: undefined,
        ok: true,
        status: 202,
        statusText: 'Accepted',
        headers: {},
        redirected: false,
        redirectInfo: { wasRedirected: false, finalUrl: request.url, originalUrl: request.url },
        response: new Response(null, { status: 202, statusText: 'Accepted' }),
        error: null,
        attempts: 0,
        durationMs: Date.now() - started,
        queued: item.id,
      };
    }
    throw new QueuedError(resolveMessage(messages, 'queued', { ...ctx, id: item.id }), {
      ...ctx,
      id: item.id,
    });
  };

  const removeItem = (id: string) =>
    mutate((items) => ({ items: items.filter((i) => i.id !== id), value: undefined }));
  const updateItem = (updated: QueuedRequest) =>
    mutate((items) => ({ items: items.map((i) => (i.id === updated.id ? updated : i)), value: undefined }));

  const replay = async (): Promise<OfflineFlushResult> => {
    const outcome = { sent: 0, dropped: 0, remaining: 0 };
    const items = await load();
    if (!client || items.length === 0 || !isOnline()) return { ...outcome, remaining: items.length };
    for (const item of items) {
      if (Date.now() - item.queuedAt > maxAge) {
        await removeItem(item.id);
        outcome.dropped++;
        notify(options.onDrop, copyQueuedRequest(item), 'expired');
        continue;
      }
      try {
        const result = await client.request(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.body,
          throwHttpErrors: true,
          meta: { ...item.meta, offline: false, offlineReplay: item.id },
        });
        await removeItem(item.id);
        outcome.sent++;
        notify(options.onReplay, copyQueuedRequest(item), result);
      } catch (error) {
        if (isNetworkError(error)) break;
        const status = isHttpError(error) ? error.status : undefined;
        if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          await removeItem(item.id);
          outcome.dropped++;
          notify(options.onDrop, copyQueuedRequest(item), 'rejected', error);
          continue;
        }
        const updated = { ...item, attempts: item.attempts + 1 };
        if (updated.attempts >= maxAttempts) {
          await removeItem(item.id);
          outcome.dropped++;
          notify(options.onDrop, copyQueuedRequest(updated), 'max-attempts', error);
          continue;
        }
        await updateItem(updated);
        if (preserveOrder) break;
      }
    }
    outcome.remaining = (await load()).length;
    return outcome;
  };

  const flush = (): Promise<OfflineFlushResult> => {
    flushing ??= (async () => {
      try {
        if (!locks) return await replay();
        // Only one tab replays at a time; the others skip instead of sending duplicates.
        return await locks.request(`${LOCK_NAME}:replay`, { ifAvailable: true }, async (lock) =>
          lock ? replay() : { sent: 0, dropped: 0, remaining: (await load()).length },
        );
      } finally {
        flushing = undefined;
      }
    })();
    return flushing;
  };

  const background = () => {
    flush().catch(() => {});
  };

  function ensureTimer() {
    if (timer !== undefined || replayInterval <= 0) return;
    timer = setInterval(background, replayInterval);
    (timer as { unref?: () => void }).unref?.();
  }

  const middleware: Middleware = async ({ request }, next) => {
    if (request.meta.offline === false || !methods.has(request.method)) return next();
    if (request.body !== undefined && request.body !== null && typeof request.body !== 'string')
      return next();
    const started = Date.now();
    if (!isOnline()) {
      const queued = await enqueue(request, started);
      if (queued) return queued;
      return next();
    }
    try {
      return await next();
    } catch (error) {
      if (!queueOn(error, request)) throw error;
      const queued = await enqueue(request, started);
      if (queued) return queued;
      throw error;
    }
  };

  return {
    name: 'offline-queue',
    middleware,
    setup(instance) {
      client = instance;
      messages = instance.getConfig().messages;
      const target = globalThis as {
        addEventListener?: Window['addEventListener'];
        removeEventListener?: Window['removeEventListener'];
      };
      if (typeof target.addEventListener === 'function' && typeof target.removeEventListener === 'function') {
        target.addEventListener('online', background);
        removeListener = () => target.removeEventListener?.('online', background);
      }
      ensureTimer();
    },
    flush,
    pending: async () => (await load()).map(copyQueuedRequest),
    clear: () => mutate(() => ({ items: [], value: undefined })),
    stop() {
      clearInterval(timer);
      timer = undefined;
      removeListener?.();
      removeListener = undefined;
    },
  };
}
