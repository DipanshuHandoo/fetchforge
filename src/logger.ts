import type { CompleteInfo, HookRequest, Plugin, RetryInfo } from './types.ts';
import { isFetchForgeError } from './errors.ts';
import { markCacheNeutral } from './internal.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Anything with level methods works: `console`, pino, winston, or your own. */
export interface LoggerLike {
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface LoggerOptions {
  /** Destination. Default `console`. */
  sink?: LoggerLike;
  /** Minimum level to emit, or `'silent'`. Default `'info'`. */
  level?: LogLevel | 'silent';
  /** Completed requests at or above this duration (ms) are logged at `warn`. Default 0 (off). */
  slowThreshold?: number;
  /** Include request headers (redacted) in debug and error logs. Default false. */
  logHeaders?: boolean;
  /** Header names whose values are replaced by `[redacted]`. Added to the defaults. */
  redactHeaders?: string[];
  /** Query parameter names whose values are replaced by `[redacted]`. Added to the defaults. */
  redactParams?: string[];
  /** Header carrying the correlation ID. Default `x-request-id`; `false` disables the ID. */
  requestIdHeader?: string | false;
}

const RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
const DEFAULT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key'];
const DEFAULT_PARAMS = [
  'token',
  'access_token',
  'api_key',
  'apikey',
  'key',
  'password',
  'secret',
  'signature',
  'sig',
];
const REDACTED = '[redacted]';

export function redactUrl(url: string, names: ReadonlySet<string>): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (names.has(key.toLowerCase())) {
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  return changed ? parsed.href : url;
}

function newId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Structured request logging. Sensitive headers and query values are redacted, and every request
 * gets a correlation ID (`request.meta.requestId`, also sent as a header) that appears in each line.
 */
export function logger(options: LoggerOptions = {}): Plugin {
  const {
    sink = console,
    level = 'info',
    slowThreshold = 0,
    logHeaders = false,
    requestIdHeader = 'x-request-id',
  } = options;
  if (!(level in RANK)) throw new RangeError(`Unknown log level: ${String(level)}`);
  if (typeof slowThreshold !== 'number' || !(slowThreshold >= 0)) {
    throw new RangeError('slowThreshold must be a non-negative number');
  }
  const headerNames = new Set([
    ...DEFAULT_HEADERS,
    ...(options.redactHeaders ?? []).map((h) => h.toLowerCase()),
  ]);
  const paramNames = new Set([
    ...DEFAULT_PARAMS,
    ...(options.redactParams ?? []).map((p) => p.toLowerCase()),
  ]);
  const threshold = RANK[level];

  const emit = (name: LogLevel, message: string, fields: Record<string, unknown>) => {
    if (RANK[name] < threshold) return;
    try {
      sink[name]?.(message, fields);
    } catch {
      // A failing log sink must never affect the request.
    }
  };

  const headersOf = (request: HookRequest) => {
    const out: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      out[key] = headerNames.has(key.toLowerCase()) ? REDACTED : value;
    });
    return out;
  };

  const base = (request: HookRequest) => ({
    requestId: request.meta.requestId,
    method: request.method,
    url: redactUrl(request.url, paramNames),
  });

  return {
    name: 'logger',
    hooks: {
      beforeRequest: markCacheNeutral((request: HookRequest) => {
        if (requestIdHeader !== false) {
          const existing = request.headers.get(requestIdHeader);
          request.meta.requestId ??= existing ?? newId();
          if (existing === null) request.headers.set(requestIdHeader, String(request.meta.requestId));
        }
        emit('debug', `${request.method} ${redactUrl(request.url, paramNames)} attempt ${request.attempt}`, {
          ...base(request),
          attempt: request.attempt,
          ...(logHeaders ? { headers: headersOf(request) } : {}),
        });
      }),
      beforeRetry: (info: RetryInfo) => {
        emit(
          'warn',
          `retrying ${info.request.method} ${redactUrl(info.request.url, paramNames)} in ${info.delay}ms`,
          {
            ...base(info.request),
            attempt: info.attempt,
            retriesLeft: info.retriesLeft,
            delay: info.delay,
            code: isFetchForgeError(info.error) ? info.error.code : undefined,
            reason: info.error.message,
          },
        );
      },
      onComplete: ({ request, result, error, attempts, durationMs }: CompleteInfo) => {
        const url = redactUrl(request.url, paramNames);
        const fields = { ...base(request), attempts, durationMs };
        if (error) {
          emit('error', `${request.method} ${url} failed after ${attempts} attempt(s): ${error.message}`, {
            ...fields,
            code: isFetchForgeError(error) ? error.code : undefined,
            status: (error as { status?: number }).status,
            ...(logHeaders ? { headers: headersOf(request) } : {}),
          });
          return;
        }
        const status = result?.status;
        const slow = slowThreshold > 0 && durationMs >= slowThreshold;
        const failedStatus = result?.error != null;
        const name: LogLevel = failedStatus || slow ? 'warn' : 'info';
        const note = slow ? ' (slow)' : '';
        emit(name, `${request.method} ${url} -> ${status} in ${durationMs}ms${note}`, { ...fields, status });
      },
      onCircuitStateChange: ({ key, from, to }) => {
        emit(to === 'open' ? 'warn' : 'info', `circuit "${key}" ${from} -> ${to}`, { key, from, to });
      },
      onHookError: (error, hook) => {
        emit('warn', `hook "${hook}" threw: ${error instanceof Error ? error.message : String(error)}`, {
          hook,
        });
      },
    },
  };
}
