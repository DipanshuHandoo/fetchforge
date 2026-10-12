import type {
  CircuitBreakerOptions,
  DedupeOptions,
  HedgingOptions,
  HookName,
  Hooks,
  Middleware,
  NormalizedHooks,
  RetryOptions,
  Settings,
} from './types.ts';
import { applyHeaders, isPlainObject } from './utils.ts';

export const DEFAULT_TIMEOUT = 60_000;
export const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export const HOOK_NAMES: readonly HookName[] = [
  'beforeRequest',
  'beforeRetry',
  'afterResponse',
  'beforeError',
  'onSuccess',
  'onError',
  'onComplete',
  'onCircuitStateChange',
  'onHookError',
];

/** Settings after merging: features are `false` or an options object, headers are a `Headers`. */
export interface MergedSettings
  extends Omit<
    Settings,
    'headers' | 'retry' | 'circuitBreaker' | 'dedupe' | 'hedging' | 'hooks' | 'middleware'
  > {
  headers: Headers;
  retry: RetryOptions | false;
  circuitBreaker: CircuitBreakerOptions | false;
  dedupe: DedupeOptions | false;
  hedging: HedgingOptions | false;
  hooks: NormalizedHooks;
  middleware: Middleware[];
}

export function emptyHooks(): NormalizedHooks {
  return Object.fromEntries(HOOK_NAMES.map((name) => [name, []])) as unknown as NormalizedHooks;
}

export function mergeHooks(base: NormalizedHooks, extra: Hooks | undefined): NormalizedHooks {
  const out = emptyHooks() as Record<HookName, unknown[]>;
  for (const name of HOOK_NAMES) {
    out[name] = [...(base as Record<HookName, unknown[]>)[name]];
    const added = extra?.[name] as unknown;
    if (added === undefined) continue;
    for (const fn of Array.isArray(added) ? added : [added]) {
      if (typeof fn !== 'function') throw new TypeError(`hooks.${name} must contain only functions`);
      out[name].push(fn);
    }
  }
  return out as unknown as NormalizedHooks;
}

export function normalizeMiddleware(value: Middleware | Middleware[] | undefined): Middleware[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  for (const fn of list) if (typeof fn !== 'function') throw new TypeError('middleware must be functions');
  return list;
}

type Feature<T extends object> = T | false;

function mergeFeature<T extends object>(
  base: Feature<T>,
  over: boolean | number | T | undefined,
  fromNumber: (n: number) => T,
  name: string,
): Feature<T> {
  if (over === undefined) return base;
  if (over === false) return false;
  if (over === true) return base === false ? ({} as T) : base;
  if (typeof over === 'number') {
    if (!Number.isFinite(over) || over < 0) throw new RangeError(`${name} must be a non-negative number`);
    return { ...(base === false ? {} : base), ...fromNumber(over) };
  }
  if (!isPlainObject(over)) throw new TypeError(`${name} must be a boolean, number or options object`);
  return { ...(base === false ? {} : base), ...over };
}

function checkNumber(name: string, value: unknown, opts: { integer?: boolean; min?: number } = {}): void {
  if (value === undefined) return;
  const min = opts.min ?? 0;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    (opts.integer && !Number.isInteger(value))
  ) {
    throw new RangeError(`${name} must be ${opts.integer ? 'an integer' : 'a number'} >= ${min}`);
  }
}

function validate(s: MergedSettings): void {
  checkNumber('timeout', s.timeout);
  checkNumber('totalTimeout', s.totalTimeout);
  if (s.retry) {
    const r = s.retry;
    checkNumber('retry.retries', r.retries, { integer: true });
    checkNumber('retry.delay', r.delay);
    checkNumber('retry.factor', r.factor, { min: 1 });
    checkNumber('retry.maxDelay', r.maxDelay);
    checkNumber('retry.maxRetryAfter', r.maxRetryAfter);
    if (r.jitter !== undefined && (typeof r.jitter !== 'number' || r.jitter < 0 || r.jitter > 1)) {
      throw new RangeError('retry.jitter must be between 0 and 1');
    }
    if (
      r.backoff !== undefined &&
      typeof r.backoff !== 'function' &&
      !['fixed', 'linear', 'exponential'].includes(r.backoff)
    ) {
      throw new TypeError('retry.backoff must be "fixed", "linear", "exponential" or a function');
    }
  }
  if (s.circuitBreaker) {
    const c = s.circuitBreaker;
    checkNumber('circuitBreaker.failureThreshold', c.failureThreshold, { integer: true, min: 1 });
    checkNumber('circuitBreaker.resetTimeout', c.resetTimeout);
    checkNumber('circuitBreaker.halfOpenMaxRequests', c.halfOpenMaxRequests, { integer: true, min: 1 });
    checkNumber('circuitBreaker.successThreshold', c.successThreshold, { integer: true, min: 1 });
  }
  if (s.hedging) {
    checkNumber('hedging.delay', s.hedging.delay);
    checkNumber('hedging.maxHedges', s.hedging.maxHedges, { integer: true, min: 1 });
  }
  if (
    s.responseType !== undefined &&
    !['auto', 'json', 'text', 'blob', 'arrayBuffer', 'formData', 'stream', 'none'].includes(s.responseType)
  ) {
    throw new TypeError(`Unsupported responseType: ${String(s.responseType)}`);
  }
  if (s.fetch !== undefined && typeof s.fetch !== 'function') throw new TypeError('fetch must be a function');
}

export function defaultSettings(): MergedSettings {
  return {
    headers: new Headers(),
    retry: false,
    circuitBreaker: false,
    dedupe: false,
    hedging: false,
    hooks: emptyHooks(),
    middleware: [],
    timeout: DEFAULT_TIMEOUT,
    responseType: 'auto',
    throwHttpErrors: true,
  };
}

/** Layers `over` on top of `base`: headers/params/meta/messages merge, hooks and middleware append. */
export function mergeSettings(base: MergedSettings, over: Settings | undefined): MergedSettings {
  if (!over) return base;
  const {
    headers,
    params,
    retry,
    circuitBreaker,
    dedupe,
    hedging,
    hooks,
    middleware,
    messages,
    meta,
    ...rest
  } = over;
  const merged: MergedSettings = { ...base };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if (headers) {
    merged.headers = new Headers(base.headers);
    applyHeaders(merged.headers, headers);
  }
  if (params !== undefined) {
    const sp = new URLSearchParams();
    for (const source of [base.params, params]) {
      if (!source) continue;
      const entries =
        source instanceof URLSearchParams
          ? [...source]
          : Object.entries(source).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
      for (const [k, v] of entries)
        if (v !== undefined && v !== null)
          sp.append(String(k), v instanceof Date ? v.toISOString() : String(v));
    }
    merged.params = sp;
  }
  merged.retry = mergeFeature(base.retry, retry, (retries) => ({ retries }), 'retry');
  merged.circuitBreaker = mergeFeature(base.circuitBreaker, circuitBreaker, () => ({}), 'circuitBreaker');
  merged.dedupe = mergeFeature(base.dedupe, dedupe, () => ({}), 'dedupe');
  merged.hedging = mergeFeature(base.hedging, hedging, (delay) => ({ delay }), 'hedging');
  merged.hooks = mergeHooks(base.hooks, hooks);
  merged.middleware = [...base.middleware, ...normalizeMiddleware(middleware)];
  if (messages) merged.messages = { ...base.messages, ...messages };
  if (meta) merged.meta = { ...base.meta, ...meta };
  validate(merged);
  return merged;
}
