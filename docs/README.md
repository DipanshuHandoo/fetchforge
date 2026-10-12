# fetchforge documentation

`@dipanshuhandoo/fetchforge` is a resilient wrapper around the standard `fetch`. Every feature is a plain option, can be set on a client and overridden per request, and is **off unless you enable it** (except typed errors, the default timeout and JSON handling).

| Guide | What it explains |
| --- | --- |
| [Getting started](./getting-started.md) | Install, first request, how a request flows |
| [Configuration reference](./configuration.md) | Every option, its default, and how client and request settings merge |
| [Requests and responses](./requests-and-responses.md) | Methods, URLs, query params, bodies, headers, response types, the result object |
| [Timeouts](./timeouts.md) | Per-attempt and total timeouts, cancellation with `AbortSignal` |
| [Retries and backoff](./retries.md) | When to retry, fixed / linear / exponential / custom delays, jitter, `Retry-After` |
| [Circuit breaker](./circuit-breaker.md) | Protecting failing services, states, keys, tuning |
| [Deduplication and hedging](./dedupe-and-hedging.md) | Collapsing identical calls; racing duplicate calls to cut tail latency |
| [Hooks](./hooks.md) | Every lifecycle hook, order, return values, error isolation |
| [Middleware and plugins](./middleware-and-plugins.md) | Wrapping the pipeline, reusable plugins, `bearerAuth` |
| [Errors and messages](./errors-and-messages.md) | Every error class, codes, guards, customising messages |
| [Bulk requests](./bulk.md) | Running many requests with a concurrency limit |
| [Metrics](./metrics.md) | Counters and latency, resetting, aborting in-flight calls |
| [API reference](./api-reference.md) | Every export, method and type |
| [Examples](../examples/README.md) | Runnable programs, one per feature, plus a full tour |
| [Troubleshooting and FAQ](./troubleshooting.md) | Common questions and pitfalls |

Project policies: [CHANGELOG](../CHANGELOG.md), [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md), [RELEASING](../RELEASING.md).
