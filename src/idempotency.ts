import { markCacheNeutral, randomId } from './internal.ts';
import type { HookRequest, Plugin } from './types.ts';

export interface IdempotencyOptions {
  /** Methods that receive a key. Default `['POST', 'PATCH']` (PUT and DELETE are idempotent by definition). */
  methods?: string[];
  /**
   * Header name. Default `'Idempotency-Key'`. Only this name makes the retry logic treat the request as safe to
   * repeat; with another name, add the method to `retry.methods` yourself.
   */
  header?: string;
  /** Key generator. Default: a random UUID v4. */
  generate?: (request: HookRequest) => string;
}

/**
 * Adds an idempotency key to mutations so they can be retried safely: the key is created once per call and reused
 * by every retry, letting the server (Stripe-style) recognise duplicates. Pass `meta: { idempotencyKey: '...' }`
 * to supply your own key (e.g. an order id) or `false` to skip.
 */
export function idempotency(options: IdempotencyOptions = {}): Plugin {
  const methods = new Set((options.methods ?? ['POST', 'PATCH']).map((m) => m.toUpperCase()));
  const header = options.header ?? 'Idempotency-Key';
  const generate = options.generate ?? (() => randomId());
  const assign = (request: HookRequest): void => {
    if (!methods.has(request.method) || request.headers.has(header)) return;
    const supplied = request.meta.idempotencyKey;
    if (supplied === false) return;
    const key = typeof supplied === 'string' && supplied !== '' ? supplied : generate(request);
    if (typeof key !== 'string' || key === '')
      throw new TypeError('idempotency: generate must return a string');
    request.headers.set(header, key);
  };
  return {
    name: 'idempotency',
    // Assigned once per call in middleware, so plugins registered after this one (e.g. offlineQueue persisting a
    // request before it is sent) already see the key. The hook covers requests that bypass middleware ordering.
    middleware: async ({ request }, next) => {
      assign(request);
      return next();
    },
    hooks: { beforeRequest: markCacheNeutral(assign) },
  };
}
