# Releasing

Publishing is a manual, protected process. Nothing here runs automatically on push.

## One-time setup (cannot be verified from the repository)

1. Own or have publish rights to the `@dipanshuhandoo` scope on npmjs.com, with 2FA enabled.
2. Configure npm **trusted publishing** for this package: npm package → Settings → Trusted Publisher → GitHub Actions, repository `DipanshuHandoo/fetchforge`, workflow `release.yml`. (For the very first publish of a new package, publish once locally with `npm publish --access public` and then switch to trusted publishing.)
3. In GitHub, create an environment named `npm` with required reviewers.

No tokens are stored in the repository or workflow.

## Release steps

1. Update `version` in `package.json` (`npm version <major|minor|patch> --no-git-tag-version`; use `x.y.z-beta.0` for prereleases) and move the `[Unreleased]` CHANGELOG entries under the new version and date.
2. `npm ci && npm run verify` and `npm run publish:dry`. Inspect the file list.
3. Commit, push, open and merge the pull request.
4. Tag the release commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Run the **Release** workflow (Actions → Release → Run workflow, or push the tag) and approve the `npm` environment. It re-runs verification, then publishes with provenance. Prerelease versions are published under the `next` dist-tag; stable versions under `latest`.
6. Post-publish verification:
   ```sh
   npm view @dipanshuhandoo/fetchforge version dist-tags
   mkdir check && cd check && npm init -y && npm i @dipanshuhandoo/fetchforge
   node -e "import('@dipanshuhandoo/fetchforge').then(m => console.log(typeof m.createClient))"
   ```
7. Create the GitHub release from the tag using the CHANGELOG notes.

## Semantic versioning

- **patch**: bug fixes with no API change.
- **minor**: backwards-compatible features.
- **major**: breaking changes to exports, option names, defaults or error types. Include migration notes in the CHANGELOG and README.

## Recovery

Published versions are immutable. If a release is broken:

- publish a corrective patch release;
- `npm deprecate @dipanshuhandoo/fetchforge@X.Y.Z "reason, use X.Y.Z+1"`;
- repoint a tag if needed: `npm dist-tag add @dipanshuhandoo/fetchforge@<good> latest`.

Unpublishing is restricted by npm policy and should only be used for leaked secrets or malware.
