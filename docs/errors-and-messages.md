# Errors and messages

Every failure is a typed error extending `FetchForgeError`, so you can branch on the cause with `instanceof`, a `code`, or a type guard.

## Common properties

| Property | Meaning |
| --- | --- |
| `name` | Class name, for example `'HttpError'` |
| `code` | Stable machine-readable code (table below) |
| `message` | Human message, built from the [message templates](#custom-messages) |
| `method`, `url` | The request |
| `attempts` | Attempts made before failing |
| `cause` | The underlying error, when there is one (for example the `TypeError` from `fetch`) |

## Error classes

| Class | `code` | Raised when | Extra properties | Retried by default |
| --- | --- | --- | --- | --- |
| `HttpError` | `ERR_HTTP` | Non-2xx response (unless `throwHttpErrors` says otherwise) | `status`, `statusText`, `headers`, `data` (parsed body), `response` | If the status is in `retry.statusCodes` |
| `TimeoutError` | `ERR_TIMEOUT` | `timeout` or `totalTimeout` expired | `timeout`, `scope` (`'attempt'` / `'total'`) | Attempt: yes. Total: never |
| `NetworkError` | `ERR_NETWORK` | `fetch` rejected (DNS, refused, reset, offline, CORS) | `cause` | Yes |
| `AbortError` | `ERR_ABORTED` | The caller's `signal` or `abortAll()` aborted | | Never |
| `CircuitOpenError` | `ERR_CIRCUIT_OPEN` | The circuit is open; no request was sent | `key`, `retryAfter` (ms) | Never |
| `ParseError` | `ERR_PARSE` | A 2xx body could not be parsed as the response type | `responseType`, `status`, `response` | No |
| `RequestError` | `ERR_INVALID_URL`, `ERR_REQUEST` | Bad URL, or `fetch` threw something other than a network failure | | No |

Invalid **options** (wrong types, out-of-range values, body on GET, and so on) throw plain `TypeError` / `RangeError` before any request, because they are programming errors.

## Handling errors

```js
import { isHttpError, isTimeoutError, isCircuitOpenError, isFetchForgeError } from '@dipanshuhandoo/fetchforge';

try {
  await api.get('/orders');
} catch (e) {
  if (isHttpError(e) && e.status === 404) return null;
  if (isTimeoutError(e)) return showSlowMessage(e.scope);
  if (isCircuitOpenError(e)) return fromCache(e.retryAfter);
  if (isFetchForgeError(e)) log(e.code, e.url, e.attempts);
  throw e;
}
```

Guards: `isFetchForgeError`, `isHttpError`, `isTimeoutError`, `isNetworkError`, `isAbortError`, `isCircuitOpenError`, `isParseError`. They are brand-based, so they keep working when two copies of the package, or different realms or bundles, are present. There is no `isRequestError`; check `e.code`.

## Custom messages

Defaults live in `DEFAULT_MESSAGES`. Override any subset through the `messages` option (client or request). Each entry is a string with `{placeholders}` or a function receiving the context:

| Key | Default template | Used by |
| --- | --- | --- |
| `http` | `HTTP {status}: {detail}` | `HttpError` |
| `timeout` | `Request timed out after {timeout}ms ({method} {url})` | `TimeoutError` (`scope: 'attempt'`) |
| `totalTimeout` | `Request exceeded the total time limit of {timeout}ms ({method} {url})` | `TimeoutError` (`scope: 'total'`) |
| `network` | `No response received from server ({method} {url}): {reason}` | `NetworkError` |
| `aborted` | `Request was aborted ({method} {url})` | `AbortError` |
| `circuitOpen` | `Circuit breaker is open for "{key}"; retry in {retryAfter}ms ({method} {url})` | `CircuitOpenError` |
| `parse` | `Failed to parse response body as {responseType} ({method} {url}): {reason}` | `ParseError` |
| `invalidUrl` | `Invalid URL: {url}` | `RequestError` |
| `request` | `Request failed ({method} {url}): {reason}` | `RequestError` |

Placeholders (available when relevant to the error): `{method}`, `{url}`, `{status}`, `{statusText}`, `{detail}` (the status text), `{timeout}`, `{attempts}`, `{key}`, `{retryAfter}`, `{responseType}`, `{reason}`. Unknown placeholders are left as written; known but missing values become empty. A custom message function that throws falls back to the default text, so a bad template never hides the real error.

```js
createClient({
  messages: {
    http: 'Server said {status} for {method} {url}',
    timeout: ({ timeout, url }) => `No answer from ${url} within ${timeout / 1000}s`,
    circuitOpen: 'Service paused, try again in {retryAfter} ms',
  },
});
```

Print `DEFAULT_MESSAGES` to see them at runtime. Changing messages never changes `code`, so program logic should use codes or guards, not message text. Example: [`errors-messages.mjs`](../examples/errors-messages.mjs).
