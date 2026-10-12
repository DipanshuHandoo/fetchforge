# Sitemap and broken-link auditor

Read a sitemap or sitemap index, check its URLs using the
[HTTP status checker](../http-status-checker/README.md), and optionally check each
page's links **one level deep**. There is no custom worker pool:
`checkBulk()` calls `client.bulk(requests, { concurrency: 5 })`.

## Run

From the repository root:

```sh
npm run build
npm ci --prefix examples/tools/sitemap-auditor/dependencies --ignore-scripts
node examples/tools/sitemap-auditor/index.mjs --demo
```

The offline demo deliberately contains broken pages/links, so **exit code 1 is
expected**. Exit 0 means no broken URLs and complete coverage; exit 1 means broken
URLs, incomplete coverage, or an execution/reporting error.

For your site, edit `input.mjs` and run without `--demo`:

```js
export const input = {
  sitemap: 'https://example.com/sitemap.xml', // Or an absolute/relative local XML file.
  inspectLinks: true,
  maxSitemaps: 50,
  maxPages: 3000,
  maxLinks: 10000,
  maxBytes: 2_000_000,
  timeout: 5000,
};
```

An empty `sitemap` selects the offline demo. `--demo` always overrides your input.
The source API is read through fetchforge; local files are read with Node streams.
Input URLs must be HTTP(S) without embedded credentials.

## Read the example

| File | Responsibility |
| --- | --- |
| `input.mjs` | Sitemap source, optional link checks and safety bounds. |
| `index.mjs` | Load input, run audit, write reports, clean up. |
| `client.mjs` | Fetchforge document client and shared status client with retries, cache, logger and monitor. |
| `auditor.mjs` | Discover sitemap pages, reuse `checkBulk()`, optionally extract/check links. |
| `reader.mjs` | Bounded stream reads; a separate deadline covers streamed response bodies. |
| `report.mjs` | CSV rows and JSON coverage summary. |
| `demo.mjs`, `smoke.mjs` | Local fixture and deterministic integration checks. |
| `dependencies/` | Private parser-only manifest/lockfile. |

XML uses `fast-xml-parser`; HTML uses Cheerio. Both are MIT-licensed and confined
to this tool, not fetchforge runtime dependencies. The separate dependency
directory preserves the repository's public-package self-reference. Outside a
clone, install fetchforge in your application and copy the tool plus its sibling
`http-status-checker`, `_shared`, and `examples/_server.mjs` demo helper.
The current parser tree has a deprecated transitive `whatwg-encoding` dependency;
the install/audit does not report a vulnerability for it.

## Output

Reports are written beside the tool in ignored `reports/`:

- `pages.csv`: input URL, first/final HTTP status, final URL, redirect chain, error.
- `links.csv`: the same fields plus source page and whether the target is outbound.
  It is empty when link inspection is disabled.
- `summary.json`: counts, broken URLs, `complete`, and discovery/page-read errors.

Console `[bulk]`, `[beforeRequest]`, `[beforeRetry]`, `[cache]`, `[monitor]`, and
report lines show what fetchforge is doing. Reports overwrite the previous run.
Tests can redirect outputs using `FETCHFORGE_EXAMPLE_REPORT_DIR`.

Discovery deduplicates URLs. Link results retain each source-page relationship,
but a target is checked only once in the link-check batch. Relative links honor
the final page URL and HTML `<base href>`; fragments, mailto and JavaScript links
are skipped. Linked pages are **not** fetched to discover more links.

## Limits and failures

Namespaced `urlset` and `sitemapindex` XML are supported. Index references may
nest within `maxSitemaps`; repeated/cyclic references are reported. Local indexes
can reference local child XML files. Page URLs must be absolute HTTP(S) URLs
when discovered from a local sitemap.

DTD/custom entities are rejected; XML escaped characters such as `&amp;` work.
UTF-8 text XML is expected. HTTP Content-Encoding decompression is handled by
fetch, but `.xml.gz` binary sitemap files and local gzip files are not supported.
Document limits apply to decoded bytes.

This tool checks HEAD statuses, so servers that reject HEAD may report 405 even
when GET works. Non-2xx responses are not cached. Page reads/fetch/parse failures,
limits and invalid entries mark coverage incomplete rather than disappearing.
Individual status failures still produce rows. SIGINT/SIGTERM cancel network
work; interrupted audits exit nonzero.

Use only on sites you are authorized to audit. Robots rules, credentials, private
network access controls and provider quotas are your responsibility. There is no
automatic robots policy or SSRF boundary here; never expose the editable input
directly to untrusted users. For very large sites, use a durable streaming crawler.

```sh
node examples/tools/sitemap-auditor/smoke.mjs
```
