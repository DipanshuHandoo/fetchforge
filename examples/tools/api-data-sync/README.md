# Bulk API data sync/migrator

Read a source API **one cursor page at a time**, transform its records, and POST
each page using fetchforge's built-in bulk concurrency. A local checkpoint lets
an interrupted run resume. Auth refresh, token-bucket limiting and idempotency
make the write-side features visible without a queue framework.

## Run

From the repository root:

```sh
npm run build
node examples/tools/api-data-sync/index.mjs --demo
```

The local demo migrates 20 contacts. It deliberately starts with an expired access
token and loses one write response, then recovers through auth refresh and a safe
POST retry. Its temporary checkpoint is isolated and removed on completion.
Each demo starts fresh; failure/resume behavior is demonstrated by `smoke.mjs`.

For a real run, edit `input.mjs`:

```js
export const input = {
  jobId: 'contacts-v1',
  sourceUrl: 'https://source.example.com',
  destinationUrl: 'https://destination.example.com',
  sourcePath: '/records',
  destinationPath: '/contacts',
  pageSize: 100,
  concurrency: 5,
  maxPages: 1000,
  timeout: 5000,
  requestsPerSecond: 10,
  recordId: (record) => String(record.id),
  transform: (record) => ({
    externalId: record.id,
    name: record.name,
    email: record.email,
  }),
  sourceAuth: {
    token: process.env.SYNC_SOURCE_TOKEN,
    refreshUrl: process.env.SYNC_SOURCE_REFRESH_URL,
    refreshToken: process.env.SYNC_SOURCE_REFRESH_TOKEN,
  },
  destinationAuth: {
    token: process.env.SYNC_DESTINATION_TOKEN,
    refreshUrl: process.env.SYNC_DESTINATION_REFRESH_URL,
    refreshToken: process.env.SYNC_DESTINATION_REFRESH_TOKEN,
  },
};
```

```sh
node examples/tools/api-data-sync/index.mjs
```

Unconfigured source URLs select the demo; `--demo` always forces it. API routes
must remain on their configured origin. Secrets come from your environment; do
not paste them into input files, reports or URL parameters.

## API contract and adaptation

The source is called with `?limit=100` and, after the first page, `&cursor=...`.
Expected JSON:

```json
{
  "items": [{ "id": 1, "name": "Ada", "email": "ada@example.com" }],
  "nextCursor": "page-2"
}
```

`nextCursor: null` marks the last page. To adapt another response shape, provide
`readPage(value)` in `input.mjs`, returning this shape; it runs as a fetchforge
response schema. The built-in `readPage()` shows the validation contract.
Record IDs must be nonempty unique strings. Transforms must synchronously return
a nonempty JSON object. Keep transforms deterministic; do not embed timestamps,
random values or changing closure/environment state in a job.

Optional auth calls a refresh endpoint with `{ refresh_token }` and expects
`{ access_token }`. Change `client.mjs` for another OAuth contract. Source and
destination have independent auth instances, rate buckets and statistics.
Refresh requests use a separate nonrecursive client. The limiter runs per attempt,
so retries also consume quota.

## Read the example

| File | Responsibility |
| --- | --- |
| `input.mjs` | APIs, page size, transformation, stable job identity and credentials. |
| `index.mjs` | Run, report, exit status and cleanup. |
| `client.mjs` | `authRefresh()`, `rateLimit()`, `idempotency()`, logger and monitor. |
| `sync.mjs` | Cursor loop, `client.bulk()`, stable keys and page commits. |
| `checkpoint.mjs` | Exclusive run lock, validated checkpoint, temp-file/rename writes. |
| `report.mjs` | Failure CSV and count/completion JSON. |
| `demo.mjs`, `smoke.mjs` | Local APIs and partial-failure/resume checks. |

Look for `[authRefresh]`, `[rateLimit]`, `[beforeRetry]`, `[bulk progress]`,
`[monitor]` and `[checkpoint]` in the terminal. No custom worker pool is used.

## Failure and resume

`state/checkpoint.json` is ignored by Git and stores the next cursor, completed
page/record counts, completed record identities and a job/configuration fingerprint.
It does **not** contain access tokens or payloads. Checkpoints use atomic rename
replacement and are committed only after **every write on a page succeeds**.

If a write still fails after retries, other writes on that page settle, the tool
reports failures and exits 1. The checkpoint does not advance. Run the same command
again to replay the page. Successfully written records on that page use the same
explicit idempotency keys, derived from job ID, destination, record ID and serialized
transformed payload. A completed checkpoint makes another run a no-op.

**The destination must implement and retain `Idempotency-Key` deduplication.**
An HTTP header alone cannot prevent duplicate writes. Delivery is at-least-once;
there is no remote transaction/rollback. Source cursors and records must remain
stable during migration/resume; keys change if the transformed payload changes.
Do not resume against a mutated dataset or nondeterministic transformation.
Provider key retention must cover your retry/resume interval.

The fingerprint rejects changed URLs/routes, job ID, page size and transformation/
adapter source. It cannot detect changed external closure values or source data.
Configuration, source, transform and checkpoint errors are explicit nonzero exits.
Ctrl+C aborts work without advancing an incomplete page.

An exclusive `state/checkpoint.lock` prevents two runs sharing this checkpoint.
A hard process crash can leave the lock: read its PID, verify that **that specific
process is no longer running**, then remove only that lock file. Never remove an
active run's lock. For an intentional new migration, archive the completed state
and choose a new `jobId`; resetting state is manual, never automatic.
Atomic file replacement protects process-interruption recovery, not power-loss
durability or cross-machine distributed locking.

Ignored `reports/failures.csv` contains record IDs/error codes/statuses, not raw
payloads. `reports/summary.json` contains completed counts and completion state.
Files overwrite each run. `FETCHFORGE_EXAMPLE_REPORT_DIR` redirects test reports.

This small-scale example retains completed IDs in its checkpoint. For millions
of records, use a durable database/queue and provider-specific cursor snapshots,
not an ever-growing JSON file.

```sh
node examples/tools/api-data-sync/smoke.mjs
```
