import { IDEMPOTENT_METHODS } from './config.ts';
import { isAbortError, isCircuitOpenError, isHttpError, isNetworkError, isTimeoutError } from './errors.ts';
import type { HookRequest, RetryOptions } from './types.ts';
import { parseRetryAfter } from './utils.ts';

export const RETRY_DEFAULTS = {
  retries: 3,
  delay: 1000,
  factor: 2,
  maxDelay: 30000,
  jitter: 0,
  statusCodes: [408, 425, 429, 500, 502, 503, 504] as number[],
  maxRetryAfter: 60000,
};

/** Built-in eligibility rules (method, status, error kind). Hard stops are applied by the caller. */
export function isRetryable(error: unknown, request: HookRequest, options: RetryOptions): boolean {
  if (isAbortError(error) || isCircuitOpenError(error)) return false;
  if (isTimeoutError(error) && (error.scope === 'total' || options.retryOnTimeout === false)) return false;
  // A request carrying an idempotency key is safe to repeat, whatever its method.
  const idempotent = request.headers.has('idempotency-key');
  if (!idempotent && !(options.methods ?? IDEMPOTENT_METHODS).includes(request.method)) return false;
  if (isHttpError(error)) return (options.statusCodes ?? RETRY_DEFAULTS.statusCodes).includes(error.status);
  if (isNetworkError(error)) return options.retryOnNetworkError !== false;
  return isTimeoutError(error);
}

export function computeDelay(
  retryNumber: number,
  options: RetryOptions,
  error: unknown,
  request: HookRequest,
): number {
  const base = options.delay ?? RETRY_DEFAULTS.delay;
  const maxDelay = options.maxDelay ?? RETRY_DEFAULTS.maxDelay;
  const strategy = options.backoff ?? 'exponential';
  let delay: number;
  if (typeof strategy === 'function') {
    delay = strategy(retryNumber, { error, request });
    if (!Number.isFinite(delay) || delay < 0) delay = 0;
  } else {
    if (strategy === 'fixed') delay = base;
    else if (strategy === 'linear') delay = base * retryNumber;
    else delay = base * (options.factor ?? RETRY_DEFAULTS.factor) ** (retryNumber - 1);
    delay = Math.min(delay, maxDelay);
  }
  const jitter = options.jitter ?? RETRY_DEFAULTS.jitter;
  return Math.round(delay + (jitter > 0 ? Math.random() * jitter * delay : 0));
}

/** Returns the wait honouring Retry-After, or `null` when the server asks for longer than allowed. */
export function applyRetryAfter(delay: number, error: unknown, options: RetryOptions): number | null {
  if (options.respectRetryAfter === false || !isHttpError(error)) return delay;
  const wait = parseRetryAfter(error.headers['retry-after']);
  if (wait === undefined) return delay;
  if (wait > (options.maxRetryAfter ?? RETRY_DEFAULTS.maxRetryAfter)) return null;
  return Math.max(delay, wait);
}
