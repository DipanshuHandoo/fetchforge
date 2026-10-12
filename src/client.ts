import { asyncSlotPool } from '@dipanshuhandoo/async-slot-pool';
import { CircuitBreaker, type CircuitToken } from './circuit.ts';
import {
  SAFE_METHODS,
  type MergedSettings,
  defaultSettings,
  mergeHooks,
  mergeSettings,
  normalizeMiddleware,
} from './config.ts';
import {
  AbortError,
  CircuitOpenError,
  type FetchForgeError,
  HttpError,
  NetworkError,
  RequestError,
  TimeoutError,
  isAbortError,
  isCircuitOpenError,
  isFetchForgeError,
  isHttpError,
  isParseError,
  isTimeoutError,
} from './errors.ts';
import { resolveMessage } from './messages.ts';
import { MetricsStore } from './metrics.ts';
import { RETRY_DEFAULTS, applyRetryAfter, computeDelay, isRetryable } from './retry.ts';
import type {
  CircuitState,
  ClientConfig,
  FetchResult,
  HookName,
  HookRequest,
  Metrics,
  Plugin,
  RequestOptions,
  RetryInfo,
  Settings,
} from './types.ts';
import {
  InternalAbort,
  attachAttempts,
  buildUrl,
  errorMessage,
  headersToObject,
  isStreamBody,
  linkSignal,
  normalizeMethod,
  parseBody,
  prepareBody,
  sleep,
} from './utils.ts';

const SETTING_KEYS = new Set([
  'baseUrl',
  'headers',
  'params',
  'timeout',
  'totalTimeout',
  'responseType',
  'throwHttpErrors',
  'retry',
  'circuitBreaker',
  'dedupe',
  'hedging',
  'hooks',
  'middleware',
  'messages',
  'fetch',
  'meta',
]);

const DEFAULT_ACCEPT = 'application/json, text/plain, */*';

export type BulkRequest = string | (RequestOptions & { url: string });

export interface BulkOptions {
  /** Maximum requests in flight at once. Default 5. */
  concurrency?: number;
  /** Stop starting new requests after the first failure. Default false. */
  stopOnError?: boolean;
  /** Cancels in-flight requests and skips the rest. */
  signal?: AbortSignal;
  onProgress?: (progress: { done: number; total: number; succeeded: number; failed: number }) => void;
}

export type BulkItem<T = unknown> =
  | { index: number; request: BulkRequest; status: 'fulfilled'; result: FetchResult<T> }
  | { index: number; request: BulkRequest; status: 'rejected'; error: Error }
  | { index: number; request: BulkRequest; status: 'skipped' };

export interface BulkResult<T = unknown> {
  /** One entry per request, in input order. */
  results: Array<BulkItem<T>>;
  fulfilled: number;
  rejected: number;
  skipped: number;
  total: number;
  /** True when `stopOnError` or `signal` stopped the run early. */
  aborted: boolean;
  durationMs: number;
}

interface DedupeEntry {
  promise: Promise<FetchResult>;
  refs: number;
  controller: AbortController;
}

const shouldThrow = (settings: MergedSettings, status: number): boolean =>
  typeof settings.throwHttpErrors === 'function'
    ? settings.throwHttpErrors(status)
    : settings.throwHttpErrors !== false;

function requestInit(settings: MergedSettings): RequestInit {
  const init: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) if (!SETTING_KEYS.has(key)) init[key] = value;
  return init as RequestInit;
}

export class FetchClient {
  #settings: MergedSettings = defaultSettings();
  #plugins = new Set<string>();
  readonly #circuits = new Map<string, CircuitBreaker>();
  readonly #inflight = new Map<string, DedupeEntry>();
  readonly #active = new Set<AbortController>();
  readonly #metrics = new MetricsStore();

  constructor(config: ClientConfig = {}) {
    if (config === null || typeof config !== 'object') throw new TypeError('config must be an object');
    const { plugins, ...settings } = config;
    this.#settings = mergeSettings(this.#settings, settings);
    for (const plugin of plugins ?? []) this.use(plugin);
  }

  /** Registers a plugin: its hooks and middleware run after those already registered. */
  use(plugin: Plugin): this {
    if (!plugin || typeof plugin.name !== 'string' || plugin.name === '') {
      throw new TypeError('A plugin must be an object with a non-empty "name"');
    }
    if (this.#plugins.has(plugin.name)) throw new TypeError(`Plugin "${plugin.name}" is already registered`);
    const hooks = mergeHooks(this.#settings.hooks, plugin.hooks);
    const middleware = [...this.#settings.middleware, ...normalizeMiddleware(plugin.middleware)];
    this.#plugins.add(plugin.name);
    this.#settings = { ...this.#settings, hooks, middleware };
    plugin.setup?.(this);
    return this;
  }

  /** Creates an independent client (own circuits, dedupe and metrics) with extra defaults layered on top. */
  extend(config: ClientConfig = {}): FetchClient {
    const { plugins, ...settings } = config;
    const child = new FetchClient();
    child.#settings = mergeSettings(this.#settings, settings);
    child.#plugins = new Set(this.#plugins);
    for (const plugin of plugins ?? []) child.use(plugin);
    return child;
  }

  getConfig(): Readonly<Settings> {
    const { headers, ...rest } = this.#settings;
    return { ...rest, headers: headersToObject(headers) } as unknown as Settings;
  }

  getMetrics(): Metrics {
    return this.#metrics.snapshot();
  }

  resetMetrics(): void {
    this.#metrics.reset();
  }

  /** Accepts a circuit key or a URL (whose origin is the default key). */
  getCircuitState(keyOrUrl: string): CircuitState {
    const circuit = this.#circuits.get(keyOrUrl) ?? this.#circuits.get(safeOrigin(keyOrUrl));
    return circuit?.state ?? 'closed';
  }

  resetCircuit(keyOrUrl?: string): void {
    if (keyOrUrl === undefined) {
      for (const circuit of this.#circuits.values()) circuit.reset();
      return;
    }
    (this.#circuits.get(keyOrUrl) ?? this.#circuits.get(safeOrigin(keyOrUrl)))?.reset();
  }

  /** Cancels every request currently in flight on this client. */
  abortAll(): void {
    for (const controller of [...this.#active]) controller.abort(new InternalAbort('client'));
  }

  get<T = unknown>(url: string, options?: RequestOptions): Promise<FetchResult<T>> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }
  head(url: string, options?: RequestOptions): Promise<FetchResult<undefined>> {
    return this.request<undefined>(url, { ...options, method: 'HEAD' });
  }
  options<T = unknown>(url: string, options?: RequestOptions): Promise<FetchResult<T>> {
    return this.request<T>(url, { ...options, method: 'OPTIONS' });
  }
  delete<T = unknown>(url: string, options?: RequestOptions): Promise<FetchResult<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }
  post<T = unknown>(url: string, body?: unknown, options?: RequestOptions): Promise<FetchResult<T>> {
    return this.request<T>(url, { ...options, method: 'POST', body });
  }
  put<T = unknown>(url: string, body?: unknown, options?: RequestOptions): Promise<FetchResult<T>> {
    return this.request<T>(url, { ...options, method: 'PUT', body });
  }
  patch<T = unknown>(url: string, body?: unknown, options?: RequestOptions): Promise<FetchResult<T>> {
    return this.request<T>(url, { ...options, method: 'PATCH', body });
  }

  async request<T = unknown>(url: string, options: RequestOptions = {}): Promise<FetchResult<T>> {
    const { method: rawMethod, body, json, signal, ...overrides } = options;
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new TypeError('signal must be an AbortSignal');
    const settings = mergeSettings(this.#settings, overrides);
    const method = normalizeMethod(rawMethod);
    const url_ = buildUrl(url, settings.baseUrl, settings.params, {
      method,
      url,
      messages: settings.messages,
    });
    const headers = new Headers(settings.headers);
    const payload = prepareBody(method, headers, body, json);
    if (!headers.has('accept')) headers.set('accept', DEFAULT_ACCEPT);
    const request: HookRequest = {
      url: url_,
      method,
      headers,
      body: payload,
      attempt: 0,
      meta: { ...settings.meta },
    };

    const metrics = this.#metrics;
    const started = Date.now();
    metrics.inc('requests');
    metrics.inFlight(1);
    try {
      const run = settings.middleware.reduceRight<() => Promise<FetchResult>>(
        (next, middleware) => () => middleware({ request, client: this }, next),
        () => this.#dedupe(request, settings, signal),
      );
      const result = await run();
      metrics.status(result.status);
      if (result.error) metrics.inc('failed');
      else metrics.inc('succeeded');
      return result as FetchResult<T>;
    } catch (error) {
      if (isHttpError(error)) metrics.status(error.status);
      if (isAbortError(error)) metrics.inc('aborted');
      else metrics.inc('failed');
      if (isTimeoutError(error)) metrics.inc('timeouts');
      throw error;
    } finally {
      metrics.inFlight(-1);
      metrics.latency(Date.now() - started);
    }
  }

  async bulk<T = unknown>(
    requests: Iterable<BulkRequest>,
    options: BulkOptions = {},
  ): Promise<BulkResult<T>> {
    const started = Date.now();
    const items = Array.from(requests);
    const { concurrency = 5, stopOnError = false, signal, onProgress } = options;
    const results: Array<BulkItem<T>> = items.map((request, index) => ({
      index,
      request,
      status: 'skipped',
    }));

    const stats = await asyncSlotPool(
      items,
      async (item, index) => {
        if (signal?.aborted) return;
        const { url, ...rest } = typeof item === 'string' ? { url: item } : item;
        try {
          const callOptions: RequestOptions = signal ? { ...rest, signal: rest.signal ?? signal } : rest;
          const result = await this.request<T>(url, callOptions);
          results[index] = { index, request: item, status: 'fulfilled', result };
        } catch (error) {
          results[index] = { index, request: item, status: 'rejected', error: error as Error };
          if (stopOnError) throw error;
        }
      },
      {
        concurrency,
        bail: stopOnError,
        onProgress: onProgress
          ? (p) =>
              onProgress({
                done: p.done,
                total: p.total ?? items.length,
                succeeded: p.succeeded,
                failed: p.failed,
              })
          : null,
      },
    );

    const count = (status: BulkItem['status']) => results.filter((r) => r.status === status).length;
    return {
      results,
      fulfilled: count('fulfilled'),
      rejected: count('rejected'),
      skipped: count('skipped'),
      total: items.length,
      aborted: stats.stats.aborted || signal?.aborted === true,
      durationMs: Date.now() - started,
    };
  }

  // ---- internals -------------------------------------------------------------------------

  async #notify<K extends HookName>(settings: MergedSettings, name: K, ...args: unknown[]): Promise<void> {
    for (const hook of settings.hooks[name] as Array<(...a: unknown[]) => unknown>) {
      try {
        await hook(...args);
      } catch (error) {
        this.#reportHookError(settings, error, name);
      }
    }
  }

  #reportHookError(settings: MergedSettings, error: unknown, hook: string): void {
    for (const report of settings.hooks.onHookError) {
      try {
        report(error, hook);
      } catch {
        // A failing error reporter must not affect the request.
      }
    }
  }

  #abortedError(request: HookRequest, settings: MergedSettings, cause?: unknown): AbortError {
    const ctx = { method: request.method, url: request.url };
    return new AbortError(resolveMessage(settings.messages, 'aborted', ctx), { ...ctx, cause });
  }

  #signalError(signal: AbortSignal, request: HookRequest, settings: MergedSettings): FetchForgeError {
    const reason: unknown = signal.reason;
    const ctx = { method: request.method, url: request.url };
    if (reason instanceof InternalAbort && (reason.kind === 'attempt' || reason.kind === 'total')) {
      const total = reason.kind === 'total';
      const timeout = (total ? settings.totalTimeout : settings.timeout) ?? 0;
      return new TimeoutError(
        resolveMessage(settings.messages, total ? 'totalTimeout' : 'timeout', { ...ctx, timeout }),
        {
          ...ctx,
          timeout,
          scope: reason.kind,
        },
      );
    }
    return this.#abortedError(request, settings, reason instanceof InternalAbort ? undefined : reason);
  }

  #dedupe(
    request: HookRequest,
    settings: MergedSettings,
    signal: AbortSignal | undefined,
  ): Promise<FetchResult> {
    const options = settings.dedupe;
    const eligible =
      options &&
      (options.methods ?? ['GET', 'HEAD']).includes(request.method) &&
      (request.body === undefined || typeof request.body === 'string');
    if (!options || !eligible) return this.#execute(request, settings, signal);

    const key =
      options.key?.(request) ??
      [
        request.method,
        request.url,
        [...request.headers].sort(([a], [b]) => (a < b ? -1 : 1)).join(';'),
        settings.responseType,
        request.body ?? '',
      ].join('\n');

    let entry = this.#inflight.get(key);
    if (entry) {
      this.#metrics.inc('deduped');
    } else {
      const controller = new AbortController();
      const created: DedupeEntry = {
        promise: Promise.resolve() as unknown as Promise<FetchResult>,
        refs: 0,
        controller,
      };
      created.promise = this.#execute(request, settings, controller.signal).finally(() => {
        if (this.#inflight.get(key) === created) this.#inflight.delete(key);
      });
      created.promise.catch(() => {});
      this.#inflight.set(key, created);
      entry = created;
    }

    const shared = entry;
    shared.refs++;
    return new Promise<FetchResult>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (--shared.refs === 0) {
          if (this.#inflight.get(key) === shared) this.#inflight.delete(key);
          shared.controller.abort(signal?.reason);
        }
        reject(this.#abortedError(request, settings, signal?.reason));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  async #execute(
    request: HookRequest,
    settings: MergedSettings,
    external: AbortSignal | undefined,
  ): Promise<FetchResult> {
    const total = new AbortController();
    const unlink = linkSignal(external, total);
    const timer = settings.totalTimeout
      ? setTimeout(() => total.abort(new InternalAbort('total')), settings.totalTimeout)
      : undefined;
    this.#active.add(total);
    const started = Date.now();

    let result: FetchResult | undefined;
    let error: Error | undefined;
    try {
      result = await this.#retryLoop(request, settings, total.signal);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    } finally {
      clearTimeout(timer);
      unlink();
      this.#active.delete(total);
    }
    const durationMs = Date.now() - started;
    const attempts = request.attempt;

    if (result) {
      result.durationMs = durationMs;
    } else if (error && isHttpError(error) && !shouldThrow(settings, error.status)) {
      result = this.#result(request, error.response, error.data, attempts, durationMs, error);
      error = undefined;
    }

    if (error) {
      for (const hook of settings.hooks.beforeError) {
        try {
          const replaced = await hook(error, request);
          if (replaced instanceof Error) error = replaced;
        } catch (hookError) {
          this.#reportHookError(settings, hookError, 'beforeError');
        }
      }
      await this.#notify(settings, 'onError', error, request);
    } else if (result) {
      await this.#notify(settings, 'onSuccess', result, request);
    }
    await this.#notify(settings, 'onComplete', { request, result, error, attempts, durationMs });

    if (error) throw error;
    return result as FetchResult;
  }

  async #retryLoop(
    request: HookRequest,
    settings: MergedSettings,
    signal: AbortSignal,
  ): Promise<FetchResult> {
    const retry = settings.retry && !isStreamBody(request.body) ? settings.retry : false;
    const maxRetries = retry ? (retry.retries ?? RETRY_DEFAULTS.retries) : 0;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw attachAttempts(this.#signalError(signal, request, settings), attempt - 1);
      request.attempt = attempt;
      this.#metrics.inc('attempts');
      try {
        const result = await this.#attempt(request, settings, signal);
        result.attempts = attempt;
        return result;
      } catch (raw) {
        if (!isFetchForgeError(raw)) throw raw;
        attachAttempts(raw, attempt);
        if (!retry || attempt > maxRetries || signal.aborted) throw raw;
        if (isAbortError(raw) || isCircuitOpenError(raw) || isTotalTimeout(raw)) throw raw;

        let retryable = isRetryable(raw, request, retry);
        if (retry.shouldRetry)
          retryable = await retry.shouldRetry({ error: raw, attempt, request, retryable });
        if (!retryable) throw raw;

        const delay = applyRetryAfter(computeDelay(attempt, retry, raw, request), raw, retry);
        if (delay === null) throw raw;
        const info: RetryInfo = { error: raw, attempt, retriesLeft: maxRetries - attempt, delay, request };
        for (const hook of settings.hooks.beforeRetry) {
          if ((await hook(info)) === false) throw raw;
        }
        this.#metrics.inc('retries');
        try {
          await sleep(Math.max(0, info.delay), signal);
        } catch {
          throw attachAttempts(this.#signalError(signal, request, settings), attempt);
        }
      }
    }
  }

  #breaker(request: HookRequest, settings: MergedSettings): CircuitBreaker {
    const options = settings.circuitBreaker || {};
    const key =
      typeof options.key === 'function'
        ? options.key({ url: request.url, method: request.method })
        : (options.key ?? safeOrigin(request.url));
    let breaker = this.#circuits.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(
        key,
        {
          failureThreshold: options.failureThreshold ?? 5,
          resetTimeout: options.resetTimeout ?? 30000,
          halfOpenMaxRequests: options.halfOpenMaxRequests ?? 1,
          successThreshold: options.successThreshold ?? 1,
        },
        (k, from, to) => {
          void this.#notify(this.#settings, 'onCircuitStateChange', { key: k, from, to });
        },
      );
      this.#circuits.set(key, breaker);
    }
    return breaker;
  }

  async #attempt(request: HookRequest, settings: MergedSettings, signal: AbortSignal): Promise<FetchResult> {
    let breaker: CircuitBreaker | undefined;
    let token: CircuitToken | undefined;
    if (settings.circuitBreaker) {
      breaker = this.#breaker(request, settings);
      const acquired = breaker.acquire();
      if (!acquired.allowed) {
        this.#metrics.inc('circuitRejections');
        const ctx = { method: request.method, url: request.url };
        throw new CircuitOpenError(
          resolveMessage(settings.messages, 'circuitOpen', {
            ...ctx,
            key: breaker.key,
            retryAfter: acquired.retryAfter,
          }),
          { ...ctx, key: breaker.key, retryAfter: acquired.retryAfter },
        );
      }
      token = acquired;
    }

    try {
      for (const hook of settings.hooks.beforeRequest) await hook(request);
      const hedging = settings.hedging;
      const hedge =
        hedging &&
        (hedging.methods ?? SAFE_METHODS).includes(request.method) &&
        !isStreamBody(request.body) &&
        settings.responseType !== 'stream';
      const result = hedge
        ? await this.#hedged(request, settings, signal, hedging)
        : await this.#send(request, settings, signal);
      if (breaker && token) breaker.success(token);
      return result;
    } catch (error) {
      if (breaker && token) {
        const custom = settings.circuitBreaker ? settings.circuitBreaker.isFailure : undefined;
        const isFailure = custom ?? defaultIsFailure;
        if (isFetchForgeError(error) && !isAbortError(error) && !isTotalTimeout(error)) {
          if (isFailure(error)) breaker.failure(token);
          else breaker.success(token);
        } else {
          breaker.release(token);
        }
      }
      throw error;
    }
  }

  #hedged(
    request: HookRequest,
    settings: MergedSettings,
    signal: AbortSignal,
    options: { delay?: number; maxHedges?: number },
  ): Promise<FetchResult> {
    const delay = options.delay ?? 200;
    const total = 1 + (options.maxHedges ?? 1);
    const group = new AbortController();
    const unlink = linkSignal(signal, group);
    return new Promise<FetchResult>((resolve, reject) => {
      let launched = 0;
      let failed = 0;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (action: () => void) => {
        done = true;
        clearTimeout(timer);
        unlink();
        action();
      };
      const launch = () => {
        if (done) return;
        if (launched++ > 0) this.#metrics.inc('hedges');
        this.#send(request, settings, group.signal).then(
          (value) => {
            if (done) return;
            finish(() => {
              group.abort(new InternalAbort('hedge'));
              resolve(value);
            });
          },
          (error) => {
            if (done) return;
            failed++;
            if (signal.aborted || failed >= total) return finish(() => reject(error));
            if (launched < total) {
              clearTimeout(timer);
              launch();
            }
          },
        );
        if (launched < total && !done) timer = setTimeout(launch, delay);
      };
      launch();
    });
  }

  async #send(request: HookRequest, settings: MergedSettings, parent: AbortSignal): Promise<FetchResult> {
    const fetchFn = settings.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function')
      throw new TypeError('No fetch implementation available; pass the "fetch" option');
    const controller = new AbortController();
    const unlink = linkSignal(parent, controller);
    const timer = settings.timeout
      ? setTimeout(() => controller.abort(new InternalAbort('attempt')), settings.timeout)
      : undefined;
    const ctx = { method: request.method, url: request.url, messages: settings.messages };
    const started = Date.now();
    let keepLink = false;
    try {
      let response: Response;
      try {
        response = await fetchFn(request.url, {
          ...requestInit(settings),
          method: request.method,
          headers: request.headers,
          body: request.body ?? null,
          signal: controller.signal,
          ...(isStreamBody(request.body) ? { duplex: 'half' } : {}),
        } as RequestInit);
      } catch (cause) {
        if (controller.signal.aborted) throw this.#signalError(controller.signal, request, settings);
        const reason = errorMessage((cause as { cause?: unknown })?.cause ?? cause);
        if (cause instanceof TypeError) {
          throw new NetworkError(resolveMessage(settings.messages, 'network', { ...ctx, reason }), {
            ...ctx,
            cause,
          });
        }
        throw new RequestError(
          resolveMessage(settings.messages, 'request', { ...ctx, reason }),
          'ERR_REQUEST',
          {
            ...ctx,
            cause,
          },
        );
      }

      for (const hook of settings.hooks.afterResponse) {
        const replaced = await hook(response, request);
        if (replaced instanceof Response) response = replaced;
      }

      const data = await parseBody(
        response,
        settings.responseType ?? 'auto',
        request.method,
        ctx,
        !response.ok,
      );
      if (!response.ok) {
        throw new HttpError(
          resolveMessage(settings.messages, 'http', {
            ...ctx,
            status: response.status,
            statusText: response.statusText,
            detail: response.statusText || 'Request failed',
          }),
          {
            method: request.method,
            url: request.url,
            status: response.status,
            statusText: response.statusText,
            headers: headersToObject(response.headers),
            data,
            response,
          },
        );
      }
      keepLink = settings.responseType === 'stream';
      return this.#result(request, response, data, request.attempt, Date.now() - started, null);
    } catch (error) {
      if (controller.signal.aborted && (!isFetchForgeError(error) || isParseError(error))) {
        throw this.#signalError(controller.signal, request, settings);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (!keepLink) unlink();
    }
  }

  #result(
    request: HookRequest,
    response: Response,
    data: unknown,
    attempts: number,
    durationMs: number,
    error: HttpError | null,
  ): FetchResult {
    return {
      url: request.url,
      method: request.method,
      data,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
      redirected: response.redirected,
      redirectInfo: {
        wasRedirected: response.redirected,
        finalUrl: response.url || request.url,
        originalUrl: request.url,
      },
      response,
      error,
      attempts,
      durationMs,
    };
  }
}

function isTotalTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string; scope?: string }).code === 'ERR_TIMEOUT' &&
    (error as { scope?: string }).scope === 'total'
  );
}

function defaultIsFailure(error: FetchForgeError): boolean {
  if (isHttpError(error)) return error.status >= 500 || error.status === 429;
  return error.code === 'ERR_NETWORK' || error.code === 'ERR_TIMEOUT';
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
