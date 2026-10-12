# Idempotency keys

`idempotency()` adds an `Idempotency-Key` header to POST and PATCH requests. The same key is sent on every retry of a call, so an API that supports idempotency keys (Stripe, Adyen, PayPal, Square, many internal APIs) processes the operation **once** even when the response was lost and the request is sent again.

It also makes those requests **retryable**: fetchforge never retries POST/PATCH by default because repeating them could duplicate side effects, but a request carrying an `Idempotency-Key` header is safe to repeat and follows the normal [retry policy](./retries.md).

```js
import { createClient, idempotency } from '@dipanshuhandoo/fetchforge';

const payments = createClient({
  baseUrl: 'https://api.payments.example',
  retry: { retries: 3, backoff: 'exponential' },
  plugins: [idempotency()],
});

await payments.post('/charges', { amount: 1999, currency: 'eur' }); // retried safely on 502/503/network errors
```

Runnable: [`examples/idempotency-offline.mjs`](../examples/idempotency-offline.mjs).

## Choosing the key

- **Default:** a random UUID per call, reused across that call's retries. Protects against lost responses and retries.
- **Business key:** pass your own so double-clicks, page reloads and replays of the same logical operation are also deduplicated:

```js
await payments.post('/charges', order.payment, { meta: { idempotencyKey: `order-${order.id}` } });
```

- `meta: { idempotencyKey: false }` sends no key for that call.
- A key already present in the request headers is left untouched.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `methods` | `['POST', 'PATCH']` | Methods that get a key. PUT and DELETE are idempotent by definition and already retryable. |
| `header` | `'Idempotency-Key'` | Header name. Only `Idempotency-Key` makes the request retryable automatically; with another name, add the method to `retry.methods` yourself. |
| `generate` | `crypto.randomUUID()` | `(request) => string`. |

## Behaviour change in 1.2.0

Retry logic now treats **any** request with an `Idempotency-Key` header as retryable, whether the header comes from this plugin or you set it yourself. Before 1.2.0 such POSTs were not retried unless `retry.methods` included POST. If an API ignores the header, don't send it (or set `retry.shouldRetry`).

## With the offline queue

The key is assigned once per call, before any other plugin sees the request, and is stored with queued requests. A request replayed by [`offlineQueue()`](./offline.md) after a reload therefore carries the same key on every replay and can't be applied twice, whatever the plugin order.

## Server side

The server must store the key with the result (typically for 24 hours) and return the stored result for a repeated key. Without server support the header is harmless but provides no guarantee.
