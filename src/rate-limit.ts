import { RateLimitError } from './errors.ts';
import { markCacheNeutral, safeOrigin } from './internal.ts';
import { type Messages, resolveMessage } from './messages.ts';
import type { HookRequest, Hooks, Plugin } from './types.ts';
import { parseRetryAfter } from './utils.ts';

export interface RateLimitOptions {
  /** Requests allowed per `interval` (also the burst size). */
  limit: number;
  /** Window length in ms; tokens refill continuously at `limit / interval`. */
  interval: number;
  /** Bucket per key. Default: the URL origin, so each API host gets its own budget. */
  key?: (request: HookRequest) => string;
  /** Waiting requests allowed per bucket; more are rejected with `RateLimitError`. Default: unlimited. */
  maxQueue?: number;
  /** Reject instead of queueing when the estimated wait exceeds this many ms. Default: unlimited. */
  maxWait?: number;
  /**
   * Pause the bucket when the server says so: `Retry-After` on 429/503, `X-RateLimit-Remaining: 0` with
   * `X-RateLimit-Reset`, or `RateLimit-Remaining: 0` with `RateLimit-Reset`. Default true.
   */
  respectHeaders?: boolean;
  /** Upper bound for a server-requested pause, ms. Default 60000. */
  maxPause?: number;
  /** Called when a request has to wait. */
  onDelay?: (info: { key: string; waitMs: number; queued: number }) => void;
}

export interface RateLimitBucketState {
  tokens: number;
  queued: number;
  /** Epoch ms until which the server asked us to pause, or 0. */
  pausedUntil: number;
}

export interface RateLimitPlugin extends Plugin {
  state(): Record<string, RateLimitBucketState>;
  /** Rejects queued requests with `RateLimitError` and clears timers, e.g. on shutdown. */
  stop(): void;
}

interface Waiter {
  request: HookRequest;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface Bucket {
  key: string;
  tokens: number;
  updatedAt: number;
  pausedUntil: number;
  queue: Waiter[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Client-side token-bucket rate limiting: requests above the budget wait in a FIFO queue instead of hitting the
 * server and earning 429s. Waiting counts toward the per-attempt `timeout`.
 */
export function rateLimit(options: RateLimitOptions): RateLimitPlugin {
  const { limit, interval } = options ?? ({} as RateLimitOptions);
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError('rateLimit: limit must be a number >= 1');
  if (!Number.isFinite(interval) || interval <= 0)
    throw new RangeError('rateLimit: interval must be a number > 0');
  const maxQueue = options.maxQueue ?? Number.POSITIVE_INFINITY;
  const maxWait = options.maxWait ?? Number.POSITIVE_INFINITY;
  const maxPause = options.maxPause ?? 60000;
  const respectHeaders = options.respectHeaders ?? true;
  const keyOf = options.key ?? ((request: HookRequest) => safeOrigin(request.url));
  const rate = limit / interval;
  const buckets = new Map<string, Bucket>();
  let messages: Partial<Messages> | undefined;

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, tokens: limit, updatedAt: Date.now(), pausedUntil: 0, queue: [], timer: undefined };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const refill = (bucket: Bucket) => {
    const now = Date.now();
    bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.updatedAt) * rate);
    bucket.updatedAt = now;
  };

  /** Ms until the `position`-th waiter (1-based) can go. */
  const estimate = (bucket: Bucket, position: number): number => {
    const pause = Math.max(0, bucket.pausedUntil - Date.now());
    return Math.max(pause, Math.ceil(Math.max(0, position - bucket.tokens) / rate));
  };

  const rejection = (request: HookRequest, key: string, reason: string, retryAfter: number) => {
    const ctx = { method: request.method, url: request.url };
    return new RateLimitError(resolveMessage(messages, 'rateLimit', { ...ctx, key, reason, retryAfter }), {
      ...ctx,
      key,
      retryAfter,
    });
  };

  const drain = (bucket: Bucket) => {
    bucket.timer = undefined;
    refill(bucket);
    while (bucket.queue.length > 0 && bucket.tokens >= 1 && Date.now() >= bucket.pausedUntil) {
      bucket.tokens -= 1;
      const waiter = bucket.queue.shift() as Waiter;
      waiter.cleanup();
      waiter.resolve();
    }
    schedule(bucket);
  };

  const schedule = (bucket: Bucket) => {
    if (bucket.timer !== undefined || bucket.queue.length === 0) return;
    // Not unref'd: queued requests must keep a Node.js process alive until they are sent.
    bucket.timer = setTimeout(() => drain(bucket), Math.max(1, estimate(bucket, 1)));
  };

  const acquire = (request: HookRequest): Promise<void> | undefined => {
    const key = keyOf(request);
    const bucket = bucketFor(key);
    refill(bucket);
    if (bucket.queue.length === 0 && bucket.tokens >= 1 && Date.now() >= bucket.pausedUntil) {
      bucket.tokens -= 1;
      return undefined;
    }
    const waitMs = estimate(bucket, bucket.queue.length + 1);
    if (bucket.queue.length >= maxQueue) throw rejection(request, key, 'queue is full', waitMs);
    if (waitMs > maxWait) throw rejection(request, key, `wait of ${waitMs}ms exceeds maxWait`, waitMs);
    try {
      options.onDelay?.({ key, waitMs, queued: bucket.queue.length + 1 });
    } catch {
      // Observers must not affect requests.
    }
    return new Promise<void>((resolve, reject) => {
      const signal = request.signal;
      const waiter: Waiter = { request, resolve, reject, cleanup: () => {} };
      if (signal) {
        // Leave the queue without a token; the aborted fetch then fails with the right error.
        const onAbort = () => {
          const index = bucket.queue.indexOf(waiter);
          if (index !== -1) bucket.queue.splice(index, 1);
          if (bucket.queue.length === 0 && bucket.timer !== undefined) {
            clearTimeout(bucket.timer);
            bucket.timer = undefined;
          }
          resolve();
        };
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      bucket.queue.push(waiter);
      schedule(bucket);
    });
  };

  const pauseFor = (response: Response): number | undefined => {
    const headers = response.headers;
    if (response.status === 429 || response.status === 503) {
      const retryAfter = parseRetryAfter(headers.get('retry-after'));
      if (retryAfter !== undefined) return retryAfter;
    }
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      if (Number.isFinite(reset) && reset > 0) return reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000;
    }
    if (headers.get('ratelimit-remaining') === '0') {
      const reset = Number(headers.get('ratelimit-reset'));
      if (Number.isFinite(reset) && reset >= 0) return reset * 1000;
    }
    return undefined;
  };

  const hooks: Hooks = { beforeRequest: markCacheNeutral((request: HookRequest) => acquire(request)) };
  if (respectHeaders) {
    hooks.afterResponse = (response, request) => {
      const pause = pauseFor(response);
      if (pause === undefined || pause <= 0) return;
      const bucket = bucketFor(keyOf(request));
      bucket.pausedUntil = Math.max(bucket.pausedUntil, Date.now() + Math.min(pause, maxPause));
    };
  }

  return {
    name: 'rate-limit',
    hooks,
    setup(client) {
      messages = client.getConfig().messages;
    },
    state() {
      const out: Record<string, RateLimitBucketState> = {};
      for (const [key, bucket] of buckets) {
        refill(bucket);
        out[key] = {
          tokens: Math.floor(bucket.tokens),
          queued: bucket.queue.length,
          pausedUntil: bucket.pausedUntil > Date.now() ? bucket.pausedUntil : 0,
        };
      }
      return out;
    },
    stop() {
      for (const bucket of buckets.values()) {
        clearTimeout(bucket.timer);
        bucket.timer = undefined;
        for (const waiter of bucket.queue.splice(0)) {
          waiter.cleanup();
          waiter.reject(rejection(waiter.request, bucket.key, 'rate limiter stopped', 0));
        }
      }
    },
  };
}
