// Auth token refresh: attach the access token, refresh it once when it expires (401), retry the failed
// requests with the new token, and send the user to login when the refresh token is no longer valid.
// Docs: docs/auth-refresh.md
import assert from 'node:assert/strict';
import { authRefresh, createClient, isAuthError } from '@dipanshuhandoo/fetchforge';
import { json, startServer } from './_server.mjs';

let validToken = 'access-1';
let refreshCalls = 0;
let refreshTokenValid = true;

const api = await startServer((req, res) => {
  if (req.url === '/oauth/token') {
    refreshCalls++;
    if (!refreshTokenValid) return json(res, 400, { error: 'invalid_grant' });
    validToken = `access-${refreshCalls + 1}`;
    return json(res, 200, { access_token: validToken });
  }
  if (req.headers.authorization !== `Bearer ${validToken}`) return json(res, 401, { error: 'expired' });
  json(res, 200, { path: req.url });
});

// Where the token lives is up to you: memory, a cookie-backed session, secure storage...
const session = { accessToken: 'access-1', refreshToken: 'refresh-abc' };
const loginRedirects = [];

// A separate client for the token endpoint, so refresh calls don't go through the auth plugin.
const authApi = createClient({ baseUrl: api.url, retry: false });

const auth = authRefresh({
  getToken: () => session.accessToken,
  refreshToken: async () => {
    const { data } = await authApi.post('/oauth/token', { refresh_token: session.refreshToken });
    session.accessToken = data.access_token;
  },
  onRefreshFailed: () => loginRedirects.push('/login'),
});

const client = createClient({ baseUrl: api.url, plugins: [auth] });

try {
  assert.equal((await client.get('/me')).status, 200);

  // The server rotates its key: every in-flight request gets 401, but only ONE refresh call is made.
  validToken = 'rotated';
  const results = await Promise.all(['/me', '/orders', '/cart', '/notifications'].map((p) => client.get(p)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(refreshCalls, 1);
  assert.equal(session.accessToken, 'access-2');

  // Proactive refresh, e.g. from a timer shortly before the token's `exp`.
  await auth.refresh();
  assert.equal(session.accessToken, 'access-3');

  // The refresh token is revoked: the request fails with AuthError and the app sends the user to login once.
  refreshTokenValid = false;
  validToken = 'revoked';
  const failure = await client.get('/me').catch((error) => error);
  assert.ok(isAuthError(failure));
  assert.deepEqual(loginRedirects, ['/login']);

  // Public endpoints can skip the plugin entirely.
  validToken = 'anything';
  const skipped = await client.get('/public', { meta: { authRefresh: false }, throwHttpErrors: false });
  assert.equal(skipped.status, 401, 'no token was attached and no refresh was attempted');

  console.log('auth refresh example passed');
} finally {
  await api.close();
}
