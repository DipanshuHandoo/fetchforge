# Response validation

Pass `schema` to validate (and optionally transform) successful response data at the boundary. If an API changes its contract, you get a `ValidationError` naming the exact field, not an `undefined` deep inside the UI. With TypeScript, `result.data` is typed from the schema.

```ts
import { z } from 'zod';
import { createClient, isValidationError } from '@dipanshuhandoo/fetchforge';

const User = z.object({ id: z.number(), email: z.string().email() });
const api = createClient({ baseUrl: 'https://api.example.com' });

const { data } = await api.get('/users/1', { schema: User }); // data: { id: number; email: string }
```

Runnable (no schema library needed): [`examples/validation.mjs`](../examples/validation.mjs).

## Supported schemas

fetchforge has no dependency on any validation library. `schema` accepts, in this order of detection:

1. A [Standard Schema](https://standardschema.dev) (`~standard.validate`): Zod 3.24+, Valibot 1, ArkType 2, Effect Schema and others. Types are inferred from it.
2. An object with `safeParse(value)` returning `{ success, data, error }`, such as older Zod.
3. An object with `parse(value)` that returns the value or throws.
4. A function `(value) => output` that returns the value or throws.

Async validators are awaited. Whatever the schema returns becomes `result.data`, so transforms, defaults and coercions apply.

## When it runs

- Only for **successful** (2xx) responses. Error bodies stay on `HttpError.data` unvalidated.
- After parsing and after the `afterResponse` hooks.
- Not for `responseType: 'stream'` (the body hasn't been read).
- Per attempt, before the result is cached, so invalid data is never stored by `cache()`.
- Set it per request, or in client defaults or `extend()` for a whole API.

## Errors

A failure throws `ValidationError` (`code: 'ERR_VALIDATION'`). It isn't retried: the same server will return the same data.

| Property | Description |
| --- | --- |
| `issues` | `{ message, path? }[]` from the schema (Standard Schema and Zod paths are kept). |
| `data` | The parsed data as received, before validation. |
| `status`, `response` | The successful response that failed validation. |
| `method`, `url` | The request. |

The message lists up to three issues, e.g. `Response failed validation (GET https://api.example.com/users/1): id: expected a number; email: expected a string`. Customise it with the `validation` key in [`messages`](./errors-and-messages.md).

```js
try {
  await api.get('/users/1', { schema: User });
} catch (error) {
  if (isValidationError(error)) {
    reportContractBreak(error.url, error.issues, error.data);
  }
  throw error;
}
```

With [`cache()`](./cache.md) and `staleIfError`, a validation failure on revalidation serves the last valid cached copy instead.

## Costs and limitations

- Validation runs on the main thread. For very large payloads (tens of MB) validate a summary or use streaming.
- Types are inferred when `schema` is passed per request. A schema set in client defaults validates at runtime but doesn't change the inferred type; pass a generic (`api.get<User>(...)`) there.
