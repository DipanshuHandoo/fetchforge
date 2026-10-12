import { type FetchForgeError, ParseError, RequestError } from './errors.ts';
import { type Messages, resolveMessage } from './messages.ts';
import type { HeadersInput, QueryParams, QueryValue, ResponseType } from './types.ts';

/** Abort reason that tells fetchforge why a signal fired, so errors can be classified without flags. */
export class InternalAbort {
  readonly kind: 'attempt' | 'total' | 'client' | 'hedge';
  constructor(kind: InternalAbort['kind']) {
    this.kind = kind;
  }
}

export interface ErrorContext {
  method: string;
  url: string;
  messages?: Partial<Messages> | undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/i;
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function normalizeMethod(method: unknown): string {
  if (method === undefined) return 'GET';
  if (typeof method !== 'string' || !METHOD_TOKEN.test(method)) {
    throw new TypeError(`Invalid HTTP method: ${String(method)}`);
  }
  const upper = method.toUpperCase();
  if (upper === 'CONNECT' || upper === 'TRACE' || upper === 'TRACK') {
    throw new TypeError(`HTTP method ${upper} is not supported`);
  }
  return upper;
}

function appendQuery(search: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;
  search.append(key, value instanceof Date ? value.toISOString() : String(value));
}

export function buildUrl(
  input: string,
  baseUrl: string | undefined,
  params: QueryParams | undefined,
  ctx: ErrorContext,
): string {
  if (typeof input !== 'string' || input === '') {
    throw new TypeError('url must be a non-empty string');
  }
  let full = input;
  if (!ABSOLUTE_URL.test(input)) {
    if (baseUrl) {
      full = `${baseUrl.replace(/\/+$/, '')}/${input.replace(/^\/+/, '')}`;
    } else if (typeof globalThis.location?.href === 'string') {
      full = new URL(input, globalThis.location.href).href;
    }
  }
  let url: URL;
  try {
    url = new URL(full);
  } catch (cause) {
    throw new RequestError(
      resolveMessage(ctx.messages, 'invalidUrl', { method: ctx.method, url: input }),
      'ERR_INVALID_URL',
      { method: ctx.method, url: input, cause },
    );
  }
  if (params) {
    if (params instanceof URLSearchParams) {
      for (const [k, v] of params) url.searchParams.append(k, v);
    } else {
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) for (const item of v) appendQuery(url.searchParams, k, item);
        else appendQuery(url.searchParams, k, v as QueryValue);
      }
    }
  }
  return url.href;
}

export function applyHeaders(target: Headers, input: HeadersInput | undefined): void {
  if (!input) return;
  if (input instanceof Headers || Array.isArray(input)) {
    for (const [k, v] of input as Iterable<[string, string]>) target.set(k, v);
    return;
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined || v === null) target.delete(k);
    else target.set(k, String(v));
  }
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function isStreamBody(body: unknown): boolean {
  return (
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
    (typeof body === 'object' && body !== null && Symbol.asyncIterator in body)
  );
}

export function prepareBody(
  method: string,
  headers: Headers,
  body: unknown,
  json: unknown,
): BodyInit | undefined {
  if (body !== undefined && body !== null && json !== undefined) {
    throw new TypeError('Provide either "body" or "json", not both');
  }
  let out: BodyInit | undefined;
  if (json !== undefined) {
    out = JSON.stringify(json);
    if (out === undefined) throw new TypeError('"json" value is not serializable');
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (body !== undefined && body !== null) {
    if (isPlainObject(body) || Array.isArray(body)) {
      out = JSON.stringify(body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else {
      out = body as BodyInit;
    }
  }
  if (out !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError(`A ${method} request cannot have a body`);
  }
  return out;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Aborts `child` when `parent` aborts. Returns a function that removes the link. */
export function linkSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

const TEXT_TYPE = /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql/i;
const BINARY_TYPE = /^(image|audio|video|font)\/|octet-stream|pdf|zip|gzip|wasm/i;

export function resolveResponseType(
  requested: ResponseType,
  response: Response,
  method: string,
): ResponseType {
  if (requested !== 'auto') return requested;
  if (method === 'HEAD' || [204, 205, 304].includes(response.status)) return 'none';
  const type = response.headers.get('content-type') ?? '';
  if (/json/i.test(type)) return 'json';
  if (TEXT_TYPE.test(type) || type === '') return 'text';
  if (BINARY_TYPE.test(type)) return 'blob';
  return 'text';
}

export async function parseBody(
  response: Response,
  requested: ResponseType,
  method: string,
  ctx: ErrorContext,
  isErrorResponse: boolean,
): Promise<unknown> {
  const type = resolveResponseType(requested, response, method);
  try {
    switch (type) {
      case 'none':
        return undefined;
      case 'stream':
        return response.body;
      case 'blob':
        return await response.blob();
      case 'arrayBuffer':
        return await response.arrayBuffer();
      case 'formData':
        return await response.formData();
      case 'text':
        return await response.text();
      default: {
        const text = await response.text();
        if (text === '') return undefined;
        try {
          return JSON.parse(text);
        } catch (cause) {
          if (isErrorResponse) return text;
          throw cause;
        }
      }
    }
  } catch (cause) {
    if (isErrorResponse && type !== 'stream') return undefined;
    throw new ParseError(
      resolveMessage(ctx.messages, 'parse', {
        method: ctx.method,
        url: ctx.url,
        responseType: type,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
      { method: ctx.method, url: ctx.url, cause, responseType: type, status: response.status, response },
    );
  }
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function attachAttempts<T extends FetchForgeError>(error: T, attempts: number): T {
  error.attempts = attempts;
  return error;
}
