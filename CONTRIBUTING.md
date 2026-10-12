# Contributing

1. Use Node.js 22 or later. Install with `npm ci`.
2. Make focused changes with tests. Behaviour changes need a test and a CHANGELOG entry under `[Unreleased]`.
3. Run the full gate before opening a pull request:

```sh
npm run verify          # clean, typecheck, lint, format check, coverage, build, packed-package check, browser check
npm run verify -- --skip-browser   # when Playwright's Chromium is not installed
```

Individual scripts: `npm run typecheck | lint | format | format:check | test | test:coverage | build | test:package | test:browser`.

Playwright's browser is installed with `npx playwright install chromium`.

## Guidelines

- Keep the public API small. Anything exported from `src/index.ts` is covered by semver.
- No new runtime dependencies without discussion.
- Tests must be deterministic and close every server, timer and connection they open.
- Never commit secrets, tokens or `.env` files.
- Use LF line endings. `.gitattributes` enforces them on checkout, including Windows; Biome uses the same convention.

## Reporting bugs

Open an issue with the package and Node.js version, a minimal reproduction and the expected versus actual behaviour. Report vulnerabilities privately; see [SECURITY.md](./SECURITY.md).
