import { AuthError, isHttpError } from './errors.ts';
import { registerCachePartition } from './internal.ts';
import { type Messages, resolveMessage } from './messages.ts';
import type { Awaitable, FetchResult, HookRequest, Middleware, Plugin } from './types.ts';
import { errorMessage, isStreamBody } from './utils.ts';

export interface AuthRefreshContext {
  request: HookRequest;
  /** The status that triggered the refresh. */
  status: number;
  /** The token the failed request was sent with. */
  token: string | undefined;
}

export interface AuthRefreshOptions {
  /** Returns the current access token (from memory, storage, a session...). `null`/`undefined` sends no header. */
  getToken: () => Awaitable<string | null | undefined>;
  /**
   * Obtains a new token, e.g. by calling your refresh endpoint. Return the new token, or save it so that `getToken`
   * returns it. Concurrent 401s share one call. Throw (or return `null`) when the session cannot be renewed.
   */
  refreshToken: (context: AuthRefreshContext) => Awaitable<string | null | undefined | void>;
  /** Header that carries the token. Default `'authorization'`. */
  header?: string;
  /** Prefix before the token; `''` sends the raw token. Default `'Bearer'`. */
  scheme?: string;
  /** Which responses mean "token expired". Default: status 401. */
  shouldRefresh?: (context: { status: number; request: HookRequest }) => boolean;
  /** Refreshes allowed per request before giving up. Default 1. */
  maxRefreshAttempts?: number;
  /** Called once per failed refresh (e.g. redirect to login). The request rejects with `AuthError`. */
  onRefreshFailed?: (error: unknown, context: AuthRefreshContext) => void;
}

export interface AuthRefreshPlugin extends Plugin {
  /** Refreshes now, sharing an in-flight refresh. */
  refresh(): Promise<void>;
}

/**
 * Attaches an access token to every request, and on 401 refreshes it once (single-flight across concurrent requests)
 * and replays the request. Mark the refresh call itself with `meta: { authRefresh: false }` if it uses the same client.
 */
export function authRefresh(options: AuthRefreshOptions): AuthRefreshPlugin {
  if (typeof options?.getToken !== 'function' || typeof options.refreshToken !== 'function') {
    throw new TypeError('authRefresh requires getToken and refreshToken functions');
  }
  const header = options.header ?? 'authorization';
  const scheme = options.scheme ?? 'Bearer';
  const shouldRefresh = options.shouldRefresh ?? (({ status }) => status === 401);
  const maxRefreshAttempts = options.maxRefreshAttempts ?? 1;
  if (!Number.isInteger(maxRefreshAttempts) || maxRefreshAttempts < 0) {
    throw new RangeError('authRefresh: maxRefreshAttempts must be an integer >= 0');
  }
  const sent = new WeakMap<HookRequest, string | undefined>();
  const prepared = new WeakMap<HookRequest, string | undefined>();
  let messages: Partial<Messages> | undefined;
  let inflight: Promise<void> | undefined;
  // When refreshToken returns the token instead of saving it, use it until getToken catches up.
  let replaced: { old: string | undefined; fresh: string } | undefined;

  const currentToken = async (): Promise<string | undefined> => {
    const token = (await options.getToken()) ?? undefined;
    if (replaced && token === replaced.old) return replaced.fresh;
    replaced = undefined;
    return token;
  };

  const runRefresh = (context: AuthRefreshContext): Promise<void> => {
    inflight ??= (async () => {
      try {
        const token = await options.refreshToken(context);
        if (token === null) throw new Error('refreshToken returned null');
        if (typeof token === 'string')
          replaced = { old: (await options.getToken()) ?? undefined, fresh: token };
        if (replaced && replaced.old === replaced.fresh) replaced = undefined;
      } catch (cause) {
        try {
          options.onRefreshFailed?.(cause, context);
        } catch {
          // Observer errors must not replace the refresh failure.
        }
        throw cause;
      }
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  const ensureFresh = async (context: AuthRefreshContext): Promise<void> => {
    const now = await currentToken();
    // Another request already refreshed while this one was in flight.
    if (now !== undefined && now !== context.token) return;
    try {
      await runRefresh(context);
    } catch (cause) {
      const ctx = { method: context.request.method, url: context.request.url };
      throw new AuthError(resolveMessage(messages, 'auth', { ...ctx, reason: errorMessage(cause) }), {
        ...ctx,
        cause,
      });
    }
  };

  const middleware: Middleware = async ({ request }, next) => {
    if (request.meta.authRefresh === false || isStreamBody(request.body)) return next();
    for (let refreshes = 0; ; refreshes++) {
      let result: FetchResult | undefined;
      let failure: unknown;
      try {
        result = await next();
      } catch (error) {
        failure = error;
      }
      const status = result ? result.status : isHttpError(failure) ? failure.status : undefined;
      if (status === undefined || refreshes >= maxRefreshAttempts || !shouldRefresh({ status, request })) {
        if (result) return result;
        throw failure;
      }
      await ensureFresh({ request, status, token: sent.get(request) });
    }
  };

  return {
    name: 'auth-refresh',
    middleware,
    hooks: {
      beforeRequest: async (request) => {
        if (request.meta.authRefresh === false) return;
        const token = prepared.has(request) ? prepared.get(request) : await currentToken();
        prepared.delete(request);
        sent.set(request, token);
        if (token !== undefined) request.headers.set(header, scheme ? `${scheme} ${token}` : token);
      },
    },
    setup(client) {
      messages = client.getConfig().messages;
      registerCachePartition(client, async (request) => {
        if (request.meta.authRefresh === false) return undefined;
        const token = await currentToken();
        sent.set(request, token);
        prepared.set(request, token);
        return token === undefined ? undefined : scheme ? `${scheme} ${token}` : token;
      });
    },
    async refresh() {
      const request = { url: '', method: 'GET', headers: new Headers(), body: null, attempt: 0, meta: {} };
      await ensureFresh({ request, status: 0, token: await currentToken() });
    },
  };
}
