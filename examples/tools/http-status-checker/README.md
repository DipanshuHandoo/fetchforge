# HTTP status checker: two small examples

Give either example a list of URLs. It prints the first status, each redirect hop,
the final URL and final status, then writes one CSV. Requires Node.js 22+.

From the repository root, run `npm run build` once. Then put your URLs in
**`input.mjs`**:

```js
export const urls = ['https://example.com/', 'http://github.com/'];
```

and run either example:

```sh
node examples/tools/http-status-checker/sequential.mjs
node examples/tools/http-status-checker/bulk.mjs
```

URLs come from the first of these that has any:

1. URLs on the command line, for a quick one-off check:
   `node examples/tools/http-status-checker/bulk.mjs https://example.com`
2. the `urls` list in `input.mjs`
3. an offline demo with **50 local URLs**: 200s, 301 -> 302 -> 200 redirect
   chains, 404s, and 503s that succeed on retry. Pass `--demo` to run it even
   when `input.mjs` has URLs.

## Start here

- `sequential.mjs`: a plain `for...of` loop, awaiting one complete URL check at a time.
- `bulk.mjs`: sends the list to `checkBulk()`, which uses the package's
  **`client.bulk(requests, { concurrency: 5 })`**. Each round checks one hop per
  unfinished URL; the next round checks redirect destinations. No custom pool:
  `client.bulk()` runs on `@dipanshuhandoo/async-slot-pool`, so at most 5
  requests are in flight and a new one starts as soon as any finishes. Each
  round logs `[bulk] N requests, concurrency 5` and its duration.
- `client.mjs`: the shared fetchforge configuration. Retries, a 5-second timeout,
  `cache()`, `logger()` and `monitor()` are visible in one place.
- `checker.mjs`: shared HEAD requests and manual redirect handling, limited to
  10 redirects, with loops and invalid destinations reported as errors.
- `report.mjs`: a small CSV writer.
- `input.mjs`: **your list of URLs**.
- `urls.mjs`: picks the command line, `input.mjs` or the demo.
- `demo.mjs`: only the local fixture server and the 50 demo URLs.
- `smoke.mjs`: automated checks, separate from the example implementation.

The labelled console lines explain when things happen:

```text
[beforeRequest] ... attempt 1
[afterResponse] ... 503
[beforeRetry] ... wait 100 ms
[beforeRequest] ... attempt 2
[afterResponse] ... 200
[onComplete] ... attempts 2
[monitor] request ...
[cache] store ...
[result] ...
[CSV report] .../http-status-checker/reports/status-sequential.csv 50 URLs
```

The logger also prints its own request/retry/completion messages. A cache hit
skips network hooks and downstream logger/monitor work; look for `[cache] hit`.
The cache is in memory for this run, stores successful HEAD responses only, and
can reuse repeated URLs or shared redirect destinations. Hooks here only log,
so the cache uses an explicit method/URL key; do not copy that key for private,
authenticated responses without adding a safe identity partition.

## CSV output

`reports/status-sequential.csv` or `reports/status-bulk.csv` is written inside
this tool folder, whichever directory you run from. The `reports/` folder is
created when needed and ignored by Git; each run overwrites its report.
It contains one row per input, in input order:

| Column | Meaning |
| --- | --- |
| `url` | Original input URL |
| `first_status` | First HTTP response status |
| `final_status` | Last HTTP response status; blank if the destination could not be reached |
| `final_url` | Last URL checked |
| `redirect_chain` | Status and URL for every received response |
| `error` | Network/timeout error, invalid redirect, loop or redirect-limit error |

404 and 500 remain ordinary report statuses because `throwHttpErrors: false`.
Network failures are reported per URL, so the other URLs still finish. CSV write
failures reject the script. Spreadsheet formula cells are escaped.

These intentionally small examples accept absolute HTTP(S) URLs as command-line
arguments, use HEAD only (a HEAD-rejecting server's 405 is reported as-is), and
hold the input/results in memory. They are not a crawler or a large-file CLI.
Node is required because browsers hide manual redirect responses. No new
dependencies, file cache, rate limiter, custom worker pool, JSON report, or CLI
option framework is needed.
