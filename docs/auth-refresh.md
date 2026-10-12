# Auth token refresh

`authRefresh()` attaches an access token to every request and, when the API answers `401`, refreshes the token **once** (even if 20 requests failed at the same moment), then repeats the failed requests with the new token. When the refresh itself fails, requests reject with `AuthError` and `onRefreshFailed` runs once, e.g. to redirect to login.

```js
import { authRefresh, createClient } from '@dipanshuhandoo/fetchforge';

const auth = authRefresh({
  getToken: () => session.accessToken,
  refreshToken: async () => {
    const { data } = await authApi.post('/oauth/token', { grant_type: 'refresh_token', refresh_token: session.refreshToken });
    session.accessToken = data.access_token;
    session.refreshToken = data.refresh_token ?? session.refreshToken;
  },
  onRefreshFailed: () => router.push('/login'),
});

const api = createClient({ baseUrl: 'https://api.example.com', plugins: [auth] });
```

Runnable: [`examples/auth-refresh.mjs`](../examples/auth-refresh.mjs).

## How it works

1. Before every attempt, `getToken()` is read and sent as `Authorization: Bearer <token>`.
2. If the response is a `401` (or anything `shouldRefresh` accepts), the plugin checks whether another request already refreshed the token since this one was sent; if so it simply repeats the request.
3. Otherwise it calls `refreshToken()`. Concurrent failures share **one** in-flight refresh (single flight).
4. The request is repeated with the new token, up to `maxRefreshAttempts` times (default 1). A second 401 after a successful refresh is returned/thrown as a normal `HttpError`, so a misconfigured token can't loop.
5. If `refreshToken` throws or returns `null`, every waiting request rejects with `AuthError` (`code: 'ERR_AUTH'`, `cause` = the original error) and `onRefreshFailed` is called once per failed refresh.

`refreshToken` can either save the new token where `getToken` reads it, or **return** it; a returned token is used until `getToken` starts returning something else.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `getToken` | required | `() => token \| null \| undefined` (sync or async). `null`/`undefined` sends no header. |
| `refreshToken` | required | `(context) => Promise<token \| void>`; throw or return `null` when the session can't be renewed. `context` has `request`, `status`, `token`. |
| `header` | `'authorization'` | Header that carries the token. |
| `scheme` | `'Bearer'` | Prefix; `''` sends the raw token (e.g. `header: 'x-api-key'`). |
| `shouldRefresh` | status 401 | `({ status, request }) => boolean`, e.g. also 403 for APIs that use it for expired tokens. |
| `maxRefreshAttempts` | `1` | Refreshes per request before giving up. |
| `onRefreshFailed` | | `(error, context) => void`. Errors thrown here are ignored. |

Plugin method: `auth.refresh()` refreshes now (sharing an in-flight refresh), e.g. from a timer shortly before the JWT's `exp`, or when the app returns from background.

Per request: `meta: { authRefresh: false }` skips the plugin (no header, no refresh) for public endpoints.

## Practical notes

- **Use a separate client (or `meta: { authRefresh: false }`) for the token endpoint**, so a failing refresh can't trigger another refresh.
- **Requests with a stream body are not repeated** (a stream can't be sent twice); they get the token but a 401 is returned as is.
- **Multiple tabs:** if tabs share a refresh token that rotates on use, coordinate with the Web Locks API or a `BroadcastChannel` inside `refreshToken`; the plugin deduplicates within one JavaScript context.
- **Cookies instead of bearer tokens:** use `getToken: () => undefined` and only `refreshToken` (calling `/session/refresh`), so the plugin still single-flights the refresh and repeats the request.
- **With `cache()`:** register `cache()` first. The auth header is added after the cache key is computed; see [cache caveats](./cache.md#caveats).
- **With retries:** retries happen inside each attempt; the refresh wraps the whole call, so a request is at most `(retries + 1) × (maxRefreshAttempts + 1)` network calls.

## Errors

| Error | When |
| --- | --- |
| `AuthError` (`ERR_AUTH`) | `refreshToken` threw or returned `null`. `cause` holds the reason. Customise the text with the `auth` message template. |
| `HttpError` 401 | Still unauthorised after `maxRefreshAttempts` refreshes, or the request had `authRefresh: false`. |

```js
import { isAuthError } from '@dipanshuhandoo/fetchforge';
try {
  await api.get('/me');
} catch (error) {
  if (isAuthError(error)) showLogin();
}
```

Compared with [`bearerAuth`](./middleware-and-plugins.md#built-in-plugin-bearerauth): `bearerAuth` only attaches a token; `authRefresh` also renews it. Use one or the other, not both.
