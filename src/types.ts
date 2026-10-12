import type { FetchForgeError, HttpError } from './errors.ts';
import type { Messages } from './messages.ts';

export type Awaitable<T> = T | PromiseLike<T>;
export type MaybeArray<T> = T | T[];

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | (string & {});

export type ResponseType = 'auto' | 'json' | 'text' | 'blob' | 'arrayBuffer' | 'formData' | 'stream' | 'none';

export type QueryValue = string | number | boolean | Date | null | undefined;
export type QueryParams = URLSearchParams | Record<string, QueryValue | ReadonlyArray<QueryValue>>;

/** `null`/`undefined` values remove a header that an outer layer (client defaults) set. */
export type HeadersInput =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | number | boolean | null | undefined>;

/** The request as seen (and mutable) by hooks and middleware. */
export interface HookRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  /** 1-based number of the attempt in progress; 0 before the first attempt. */
  attempt: number;
  /** Free-form data passed through `meta` options, for correlating hooks with callers. */
  readonly meta: Record<string, unknown>;
  /** Aborts when the call is cancelled or times out. Set before `beforeRequest` hooks run. */
  signal?: AbortSignal;
}

/** How the `cache()` plugin produced a result: fresh entry, stale entry, 304 revalidation or network. */
export type CacheStatus = 'hit' | 'stale' | 'revalidated' | 'miss';

export interface TransferProgress {
  /** Bytes transferred so far. */
  loaded: number;
  /** Total bytes when known (`Content-Length`, known body size), otherwise `undefined`. */
  total: number | undefined;
  /** 0–100 when `total` is known, otherwise `undefined`. */
  percent: number | undefined;
}

/** Validation issue, compatible with Standard Schema issues. */
export interface SchemaIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
}

/** A Standard Schema (Zod 3.24+, Valibot, ArkType, ...): https://standardschema.dev */
export interface StandardSchemaLike<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<SchemaIssue> }
      | PromiseLike<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<SchemaIssue> }
        >;
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
  };
}

/**
 * Validates response data. Accepts a Standard Schema, an object with `safeParse` or `parse`
 * (Zod, Yup-style), or a function that returns the validated value or throws.
 */
export type SchemaLike<Output = unknown> =
  | StandardSchemaLike<Output>
  | { safeParse: (value: unknown) => unknown }
  | { parse: (value: unknown) => Output }
  | ((value: unknown) => Output | PromiseLike<Output>);

/** The data type a schema produces. */
export type SchemaOutput<S> = S extends { readonly '~standard': { readonly types?: infer Types } }
  ? NonNullable<Types> extends { readonly output: infer O }
    ? O
    : unknown
  : S extends { safeParse: (value: unknown) => infer R }
    ? R extends { success: true; data: infer D }
      ? D
      : unknown
    : S extends { parse: (value: unknown) => infer O }
      ? O
      : S extends (value: unknown) => infer O
        ? Awaited<O>
        : unknown;

export interface FetchResult<T = unknown> {
  /** The URL that was requested (after `baseUrl` and `params` were applied). */
  url: string;
  method: string;
  data: T;
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  redirected: boolean;
  redirectInfo: { wasRedirected: boolean; finalUrl: string; originalUrl: string };
  /** The underlying response. Its body is already consumed unless `responseType` is `'stream'`. */
  response: Response;
  /** Set only when `throwHttpErrors` let a non-2xx response resolve. */
  error: HttpError | null;
  attempts: number;
  durationMs: number;
  /** Set by the `cache()` plugin. */
  cache?: CacheStatus;
  /** Set by the `offlineQueue()` plugin (`resolve` mode): the id of the queued request. */
  queued?: string;
}

export type BackoffFunction = (retryNumber: number, info: { error: unknown; request: HookRequest }) => number;
export type BackoffStrategy = 'fixed' | 'linear' | 'exponential' | BackoffFunction;

export interface ShouldRetryInfo {
  error: unknown;
  /** The attempt that just failed (1-based). */
  attempt: number;
  request: HookRequest;
  /** What the built-in rules decided. */
  retryable: boolean;
}

export interface RetryOptions {
  /** Retries after the first attempt. Default 3 when retry is enabled. */
  retries?: number;
  /** Base delay in ms. Default 1000. */
  delay?: number;
  /**
   * `'fixed'`: delay, delay, delay. `'linear'`: delay, 2×delay, 3×delay (5s, 10s, 15s).
   * `'exponential'` (default): delay, delay×factor, delay×factor². Or a function returning ms.
   */
  backoff?: BackoffStrategy;
  /** Growth factor for exponential backoff. Default 2. */
  factor?: number;
  /** Upper bound for built-in backoff delays in ms. Default 30000. */
  maxDelay?: number;
  /** Extra random wait of up to `jitter × delay`, 0–1. Default 0. */
  jitter?: number;
  /** Methods that may be retried. Default GET, HEAD, OPTIONS, PUT, DELETE. */
  methods?: string[];
  /** Status codes that may be retried. Default 408, 425, 429, 500, 502, 503, 504. */
  statusCodes?: number[];
  /** Retry per-attempt timeouts. Default true. */
  retryOnTimeout?: boolean;
  /** Retry network errors. Default true. */
  retryOnNetworkError?: boolean;
  /** Honour the `Retry-After` header. Default true. */
  respectRetryAfter?: boolean;
  /** Give up instead of waiting when `Retry-After` exceeds this many ms. Default 60000. */
  maxRetryAfter?: number;
  /** Overrides the built-in method/status/error rules (the retry count still applies). */
  shouldRetry?: (info: ShouldRetryInfo) => Awaitable<boolean>;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before a trial request, in ms. Default 30000. */
  resetTimeout?: number;
  /** Concurrent trial requests allowed while half-open. Default 1. */
  halfOpenMaxRequests?: number;
  /** Successful trials needed to close the circuit. Default 1. */
  successThreshold?: number;
  /** Which errors count as failures. Default: network errors, timeouts, HTTP 5xx and 429. */
  isFailure?: (error: FetchForgeError) => boolean;
  /** Circuit grouping. Default: the URL origin. */
  key?: string | ((request: { url: string; method: string }) => string);
}

export interface DedupeOptions {
  /** Methods that are deduplicated. Default GET, HEAD. */
  methods?: string[];
  /** Custom identity of a request. Default: method, URL, headers and response type. */
  key?: (request: HookRequest) => string;
}

export interface HedgingOptions {
  /** Wait this many ms for a response before sending a duplicate. Default 200. */
  delay?: number;
  /** Maximum duplicates per attempt. Default 1. */
  maxHedges?: number;
  /** Methods that may be hedged. Default GET, HEAD, OPTIONS. */
  methods?: string[];
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RetryInfo {
  error: FetchForgeError;
  /** The attempt that just failed (1-based). */
  attempt: number;
  retriesLeft: number;
  /** Milliseconds that will be waited before the next attempt. Assign to change it. */
  delay: number;
  request: HookRequest;
}

export interface CompleteInfo {
  request: HookRequest;
  result?: FetchResult;
  error?: Error;
  attempts: number;
  durationMs: number;
}

export interface Hooks {
  /** Runs before every attempt. Mutate the request to change what is sent. */
  beforeRequest?: MaybeArray<(request: HookRequest) => Awaitable<void>>;
  /** Runs before waiting for a retry. Return `false` to stop retrying. */
  beforeRetry?: MaybeArray<(info: RetryInfo) => Awaitable<void | false>>;
  /** Runs after each response. Clone before reading the body; return a Response to replace it. */
  afterResponse?: MaybeArray<(response: Response, request: HookRequest) => Awaitable<void | Response>>;
  /** Runs once on the final failure; return an Error to replace it. */
  beforeError?: MaybeArray<(error: Error, request: HookRequest) => Awaitable<void | Error>>;
  onSuccess?: MaybeArray<(result: FetchResult, request: HookRequest) => Awaitable<void>>;
  onError?: MaybeArray<(error: Error, request: HookRequest) => Awaitable<void>>;
  /** Runs last, on success and failure alike (a `finally`). */
  onComplete?: MaybeArray<(info: CompleteInfo) => Awaitable<void>>;
  /** Client-level only: circuits are shared between requests. */
  onCircuitStateChange?: MaybeArray<
    (info: { key: string; from: CircuitState; to: CircuitState }) => Awaitable<void>
  >;
  /** Receives errors thrown by observer hooks, which never affect the request. */
  onHookError?: MaybeArray<(error: unknown, hook: string) => void>;
}

export type HookName = keyof Hooks;

export type HookList<K extends HookName> = Array<Exclude<NonNullable<Hooks[K]>, readonly unknown[]>>;
export type NormalizedHooks = { [K in HookName]-?: HookList<K> };

export interface MiddlewareContext {
  request: HookRequest;
  client: import('./client.ts').FetchClient;
}

/** Koa-style: call `next()` to continue, or return your own result to short-circuit. */
export type Middleware = (ctx: MiddlewareContext, next: () => Promise<FetchResult>) => Promise<FetchResult>;

export interface Plugin {
  name: string;
  hooks?: Hooks;
  middleware?: Middleware | Middleware[];
  setup?: (client: import('./client.ts').FetchClient) => void;
}

export type RequestInitExtras = Omit<RequestInit, 'method' | 'headers' | 'body' | 'signal'>;

export interface Settings extends RequestInitExtras {
  baseUrl?: string;
  headers?: HeadersInput;
  params?: QueryParams;
  /** Per-attempt timeout in ms. Default 60000, 0 disables. */
  timeout?: number;
  /** Timeout across all attempts and retry delays, in ms. Default 0 (none). */
  totalTimeout?: number;
  responseType?: ResponseType;
  /** `false` resolves non-2xx responses with `error` set; a function decides per status. Default true. */
  throwHttpErrors?: boolean | ((status: number) => boolean);
  /** `true`, a retry count, or options. `false` disables an inherited setting. */
  retry?: boolean | number | RetryOptions;
  circuitBreaker?: boolean | CircuitBreakerOptions;
  dedupe?: boolean | DedupeOptions;
  /** `true`, a delay in ms, or options. */
  hedging?: boolean | number | HedgingOptions;
  hooks?: Hooks;
  middleware?: Middleware | Middleware[];
  messages?: Partial<Messages>;
  /** A custom fetch implementation. Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  meta?: Record<string, unknown>;
  /** Validates (and may transform) successful response data; failures throw `ValidationError`. */
  schema?: SchemaLike;
  /** Called as the response body downloads. */
  onDownloadProgress?: (progress: TransferProgress) => void;
  /**
   * Called as the request body uploads. Streams the body, so it needs runtime support for streaming
   * request bodies (Node.js; Chromium over HTTP/2) and sends it chunked, without `Content-Length`.
   */
  onUploadProgress?: (progress: TransferProgress) => void;
}

export interface ClientConfig extends Settings {
  plugins?: Plugin[];
}

export interface RequestOptions extends Settings {
  method?: HttpMethod;
  /** Plain objects and arrays are sent as JSON. */
  body?: unknown;
  /** Always JSON-encoded and sets `Content-Type: application/json`. */
  json?: unknown;
  signal?: AbortSignal;
}

export interface Metrics {
  requests: number;
  inFlight: number;
  succeeded: number;
  failed: number;
  aborted: number;
  timeouts: number;
  attempts: number;
  retries: number;
  circuitRejections: number;
  deduped: number;
  hedges: number;
  statusCodes: Record<string, number>;
  latency: { count: number; min: number; max: number; avg: number; last: number };
}
