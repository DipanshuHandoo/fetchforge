import type { Plugin } from './types.ts';

export interface BearerAuthOptions {
  /** Header to set. Default `Authorization`. */
  header?: string;
  /** Prefix before the token. Default `Bearer`; use `''` for none. */
  scheme?: string;
}

/**
 * Adds an auth header to every attempt (so refreshed tokens apply to retries).
 * `token` may be a function, sync or async; returning a falsy value skips the header.
 * A header already set on the request is left untouched.
 */
export function bearerAuth(
  token: string | (() => string | undefined | null | Promise<string | undefined | null>),
  options: BearerAuthOptions = {},
): Plugin {
  if (typeof token !== 'string' && typeof token !== 'function') {
    throw new TypeError('bearerAuth requires a token string or function');
  }
  const header = options.header ?? 'Authorization';
  const scheme = options.scheme ?? 'Bearer';
  // Remembers what this plugin set so a retry can refresh it without overriding a caller's own header.
  const applied = new WeakMap<object, string>();
  return {
    name: 'bearerAuth',
    hooks: {
      beforeRequest: async (request) => {
        const current = request.headers.get(header);
        if (current !== null && applied.get(request) !== current) return;
        const value = typeof token === 'function' ? await token() : token;
        if (!value) {
          request.headers.delete(header);
          applied.delete(request);
          return;
        }
        const next = scheme ? `${scheme} ${value}` : value;
        request.headers.set(header, next);
        applied.set(request, next);
      },
    },
  };
}
