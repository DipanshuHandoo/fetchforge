/** A canned reply. `json` sets `Content-Type: application/json`; `error: 'network'` rejects like a dropped connection. */
export interface MockReply {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  body?: BodyInit | null;
  /** Wait before replying, ms (abort-aware). */
  delay?: number;
  error?: 'network' | Error;
}

export interface MockRequestInfo {
  url: string;
  method: string;
  headers: Headers;
  /** The body as text (empty string when there is none). */
  body: string;
  /** Parsed JSON body, or `undefined` when the body is not JSON. */
  json: unknown;
  /** Path parameters captured by `:name` segments. */
  params: Record<string, string>;
  /** 1-based count of calls this route has answered, including this one. */
  call: number;
  signal: AbortSignal | undefined;
}

export type MockResponder =
  | MockReply
  | Response
  | ((info: MockRequestInfo) => MockReply | Response | Promise<MockReply | Response>);

export type MockPattern = string | RegExp | ((url: URL, method: string) => boolean);

export interface MockRouteOptions {
  /** Answer only this many calls, then fall through to later routes / `onUnmatched`. */
  times?: number;
}

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** Index of the matching route, or -1 when unmatched. */
  route: number;
}

export interface MockFetchOptions {
  /** `'error'` (default) rejects unmatched requests; `'passthrough'` sends them with the real `fetch`. */
  onUnmatched?: 'error' | 'passthrough';
  /** Resolves relative patterns like `'/users/:id'`. Without it they match any origin. */
  baseUrl?: string;
}

type Route = {
  method: string;
  pattern: MockPattern;
  replies: MockResponder[];
  times: number;
  calls: number;
};

type Shortcut = (
  pattern: MockPattern,
  reply: MockResponder | MockResponder[],
  options?: MockRouteOptions,
) => MockFetch;

export interface MockFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Adds a route. An array of replies is served in order; the last one repeats. */
  on(
    method: string,
    pattern: MockPattern,
    reply: MockResponder | MockResponder[],
    options?: MockRouteOptions,
  ): MockFetch;
  get: Shortcut;
  post: Shortcut;
  put: Shortcut;
  patch: Shortcut;
  delete: Shortcut;
  head: Shortcut;
  /** Any method. */
  any: Shortcut;
  /** Every request received, in order. */
  readonly calls: MockCall[];
  /** Routes that still have `times` left to answer. */
  pending(): Array<{ method: string; pattern: string }>;
  /** Removes routes and recorded calls. */
  reset(): void;
}

function abortError(signal: AbortSignal | undefined | null): unknown {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function wait(ms: number, signal: AbortSignal | undefined | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function compilePath(path: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
}

function matchPattern(
  pattern: MockPattern,
  url: URL,
  method: string,
  baseUrl: string | undefined,
): Record<string, string> | undefined {
  if (typeof pattern === 'function') return pattern(url, method) ? {} : undefined;
  if (pattern instanceof RegExp) {
    const match = pattern.exec(url.href);
    return match ? { ...match.groups } : undefined;
  }
  let target = pattern;
  let compareOrigin: string | undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(pattern)) {
    const parsed = new URL(pattern);
    compareOrigin = parsed.origin;
    target = parsed.pathname + parsed.search;
  } else if (baseUrl) {
    const parsed = new URL(`${baseUrl.replace(/\/+$/, '')}/${pattern.replace(/^\/+/, '')}`);
    compareOrigin = parsed.origin;
    target = parsed.pathname + parsed.search;
  }
  if (compareOrigin !== undefined && compareOrigin !== url.origin) return undefined;
  const [path = '', query] = target.split('?');
  if (query !== undefined) {
    const wanted = new URLSearchParams(query);
    for (const [key, value] of wanted) if (!url.searchParams.getAll(key).includes(value)) return undefined;
  }
  const { regex, names } = compilePath(path);
  const match = regex.exec(url.pathname);
  if (!match) return undefined;
  return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? '')]));
}

function toResponse(reply: MockReply): Response {
  const headers = new Headers(reply.headers);
  let body: BodyInit | null | undefined = reply.body;
  if (reply.json !== undefined) {
    body = JSON.stringify(reply.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (reply.text !== undefined) {
    body = reply.text;
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
  }
  const status = reply.status ?? 200;
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : (body ?? null), {
    status,
    statusText: reply.statusText ?? '',
    headers,
  });
}

/**
 * A `fetch` replacement for tests and storybooks: pass it as the client's `fetch` option. Routes match by method and
 * path pattern (`'/users/:id'`), absolute URL, RegExp or predicate; replies can be objects, Responses, functions or
 * sequences. No network, no global patching.
 */
export function mockFetch(options: MockFetchOptions = {}): MockFetch {
  const routes: Route[] = [];
  const calls: MockCall[] = [];
  const realFetch = globalThis.fetch;
  const onUnmatched = options.onUnmatched ?? 'error';

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const signal = init?.signal ?? request.signal;
    if (signal?.aborted) throw abortError(signal);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const bodyText = request.body ? await request.clone().text() : '';
    const headerRecord: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headerRecord[name] = value;
    });

    let index = -1;
    let params: Record<string, string> | undefined;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i] as Route;
      if (route.calls >= route.times) continue;
      if (route.method !== '*' && route.method !== method) continue;
      params = matchPattern(route.pattern, url, method, options.baseUrl);
      if (params) {
        index = i;
        break;
      }
    }
    calls.push({ url: url.href, method, headers: headerRecord, body: bodyText, route: index });

    if (index === -1) {
      if (onUnmatched === 'passthrough') return realFetch(input, init);
      throw new Error(`mockFetch: no route for ${method} ${url.href}`);
    }

    const route = routes[index] as Route;
    route.calls++;
    const responder = route.replies[Math.min(route.calls - 1, route.replies.length - 1)] as MockResponder;
    let json: unknown;
    try {
      json = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      json = undefined;
    }
    const info: MockRequestInfo = {
      url: url.href,
      method,
      headers: request.headers,
      body: bodyText,
      json,
      params: params ?? {},
      call: route.calls,
      signal: signal ?? undefined,
    };
    if (signal?.aborted) throw abortError(signal);
    const reply = typeof responder === 'function' ? await responder(info) : responder;
    if (reply instanceof Response) return reply.clone();
    if (reply.delay) await wait(reply.delay, signal);
    if (reply.error === 'network') throw new TypeError('fetch failed');
    if (reply.error) throw reply.error;
    return toResponse(reply);
  };

  const mock = handler as MockFetch;
  const on: MockFetch['on'] = (method, pattern, reply, routeOptions = {}) => {
    const replies = Array.isArray(reply) ? reply : [reply];
    if (replies.length === 0) throw new TypeError('mockFetch: at least one reply is required');
    const times = routeOptions.times ?? Number.POSITIVE_INFINITY;
    if (!(times >= 1)) throw new RangeError('mockFetch: times must be >= 1');
    routes.push({ method: method === '*' ? '*' : method.toUpperCase(), pattern, replies, times, calls: 0 });
    return mock;
  };
  const shortcut =
    (method: string): Shortcut =>
    (pattern, reply, routeOptions) =>
      on(method, pattern, reply, routeOptions);

  Object.assign(mock, {
    on,
    get: shortcut('GET'),
    post: shortcut('POST'),
    put: shortcut('PUT'),
    patch: shortcut('PATCH'),
    delete: shortcut('DELETE'),
    head: shortcut('HEAD'),
    any: shortcut('*'),
    pending: () =>
      routes
        .filter((route) => Number.isFinite(route.times) && route.calls < route.times)
        .map((route) => ({ method: route.method, pattern: String(route.pattern) })),
    reset() {
      routes.length = 0;
      calls.length = 0;
    },
  });
  Object.defineProperty(mock, 'calls', { get: () => calls, enumerable: true });
  return mock;
}
