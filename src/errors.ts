const BRAND = Symbol.for('fetchforge.error');

/** Machine-readable error codes. */
export type ErrorCode =
  | 'ERR_HTTP'
  | 'ERR_TIMEOUT'
  | 'ERR_NETWORK'
  | 'ERR_ABORTED'
  | 'ERR_CIRCUIT_OPEN'
  | 'ERR_PARSE'
  | 'ERR_INVALID_URL'
  | 'ERR_REQUEST';

export interface FetchForgeErrorOptions {
  method: string;
  url: string;
  cause?: unknown;
}

/** Base class for every error created by fetchforge. */
export class FetchForgeError extends Error {
  readonly code: ErrorCode;
  readonly method: string;
  readonly url: string;
  /** Number of attempts made before this error was produced (0 when nothing was sent). */
  attempts = 0;

  constructor(message: string, code: ErrorCode, options: FetchForgeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FetchForgeError';
    this.code = code;
    this.method = options.method;
    this.url = options.url;
    Object.defineProperty(this, BRAND, { value: true });
  }
}

export interface HttpErrorOptions extends FetchForgeErrorOptions {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
  response: Response;
}

/** The server answered with a status that `throwHttpErrors` rejects (any non-2xx by default). */
export class HttpError<TData = unknown> extends FetchForgeError {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly data: TData;
  readonly response: Response;

  constructor(message: string, options: HttpErrorOptions) {
    super(message, 'ERR_HTTP', options);
    this.name = 'HttpError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.headers = options.headers;
    this.data = options.data as TData;
    this.response = options.response;
  }
}

export type TimeoutScope = 'attempt' | 'total';

/** One attempt (`timeout`) or the whole request including retries (`totalTimeout`) took too long. */
export class TimeoutError extends FetchForgeError {
  readonly timeout: number;
  readonly scope: TimeoutScope;

  constructor(message: string, options: FetchForgeErrorOptions & { timeout: number; scope: TimeoutScope }) {
    super(message, 'ERR_TIMEOUT', options);
    this.name = 'TimeoutError';
    this.timeout = options.timeout;
    this.scope = options.scope;
  }
}

/** No response was received: DNS failure, connection refused or reset, CORS, offline... */
export class NetworkError extends FetchForgeError {
  constructor(message: string, options: FetchForgeErrorOptions) {
    super(message, 'ERR_NETWORK', options);
    this.name = 'NetworkError';
  }
}

/** The request was cancelled through `signal`, `bulk({ signal })` or `client.abortAll()`. */
export class AbortError extends FetchForgeError {
  constructor(message: string, options: FetchForgeErrorOptions) {
    super(message, 'ERR_ABORTED', options);
    this.name = 'AbortError';
  }
}

/** The circuit for this request's key is open, so nothing was sent. */
export class CircuitOpenError extends FetchForgeError {
  readonly key: string;
  /** Milliseconds until the circuit allows a trial request (0 while half-open and saturated). */
  readonly retryAfter: number;

  constructor(message: string, options: FetchForgeErrorOptions & { key: string; retryAfter: number }) {
    super(message, 'ERR_CIRCUIT_OPEN', options);
    this.name = 'CircuitOpenError';
    this.key = options.key;
    this.retryAfter = options.retryAfter;
  }
}

/** The response body could not be read as the requested `responseType`. */
export class ParseError extends FetchForgeError {
  readonly responseType: string;
  readonly status: number;
  readonly response: Response;

  constructor(
    message: string,
    options: FetchForgeErrorOptions & { responseType: string; status: number; response: Response },
  ) {
    super(message, 'ERR_PARSE', options);
    this.name = 'ParseError';
    this.responseType = options.responseType;
    this.status = options.status;
    this.response = options.response;
  }
}

/** The request could not be created or sent: invalid URL or an unexpected `fetch` failure. */
export class RequestError extends FetchForgeError {
  constructor(message: string, code: 'ERR_INVALID_URL' | 'ERR_REQUEST', options: FetchForgeErrorOptions) {
    super(message, code, options);
    this.name = 'RequestError';
  }
}

/** Works across realms and duplicate package copies, unlike `instanceof`. */
export function isFetchForgeError(value: unknown): value is FetchForgeError {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}

const hasCode = (value: unknown, code: ErrorCode): boolean => isFetchForgeError(value) && value.code === code;

export const isHttpError = (value: unknown): value is HttpError => hasCode(value, 'ERR_HTTP');
export const isTimeoutError = (value: unknown): value is TimeoutError => hasCode(value, 'ERR_TIMEOUT');
export const isNetworkError = (value: unknown): value is NetworkError => hasCode(value, 'ERR_NETWORK');
export const isAbortError = (value: unknown): value is AbortError => hasCode(value, 'ERR_ABORTED');
export const isCircuitOpenError = (value: unknown): value is CircuitOpenError =>
  hasCode(value, 'ERR_CIRCUIT_OPEN');
export const isParseError = (value: unknown): value is ParseError => hasCode(value, 'ERR_PARSE');
