# Middleware and plugins

## Middleware

**Purpose:** wrap the entire call (dedupe, retries, hooks and all) to short-circuit, transform or time it. Koa-style:

```js
const timing = async ({ request, client }, next) => {
  const start = Date.now();
  try {
    return await next();
  } finally {
    console.log(request.method, request.url, Date.now() - start, 'ms');
  }
};
const api = createClient({ middleware: timing }); // or an array
```

- Signature: `(ctx: { request, client }, next: () => Promise<FetchResult>) => Promise<FetchResult>`.
- The first middleware registered is the outermost. Client middleware runs before request-level middleware.
- Runs **once per call**, not per attempt. Use `beforeRequest` for per-attempt work.
- Return a `FetchResult` without calling `next()` to short-circuit (for example, a cache or a mock). Wrap `next()` in `try/catch` to recover from errors.
- You may modify `ctx.request` before calling `next()`.

## Plugins

> Full guide with the built-in plugin catalog, authoring advice and recipes (webhooks, caching, rate limits): [plugins](./plugins.md).

**Purpose:** bundle hooks, middleware and setup into a reusable unit.

```ts
interface Plugin {
  name: string;                      // required, unique per client
  hooks?: Hooks;
  middleware?: Middleware | Middleware[];
  setup?: (client: FetchClient) => void;  // runs once on registration
}
```

```js
const logging = {
  name: 'logging',
  hooks: { onComplete: ({ request, error }) => console.log(request.url, error ? 'failed' : 'ok') },
};
const api = createClient({ plugins: [logging] });
api.use(anotherPlugin); // or register later; returns the client for chaining
```

- Plugin hooks and middleware are added **after** the ones already on the client.
- Registering the same `name` twice on a client throws `TypeError`. `extend()` copies the registered names, so a child cannot re-register an inherited plugin.
- `setup(client)` is where a plugin can read `client.getConfig()` or call `client.use`.

## Built-in plugin: `bearerAuth`

```js
import { bearerAuth } from '@dipanshuhandoo/fetchforge';

createClient({ plugins: [bearerAuth(() => tokenStore.get())] });
```

| Argument | Meaning |
| --- | --- |
| `token` | A string, or a (possibly async) function returning one. A function is called on **every attempt**, so a refreshed token is used on retries. |
| `options.header` | Header name. Default `Authorization`. |
| `options.scheme` | Prefix. Default `Bearer`; use `''` for a raw token. |

An `Authorization` (or custom header) set explicitly on the request is not overwritten. If the function returns an empty value, no header is added.

Example: [`middleware-plugins.mjs`](../examples/middleware-plugins.mjs).
