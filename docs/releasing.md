# Releasing

The repository publishes two independent npm packages:

- `@gkoreli/ghostty-vt-js`
- `@gkoreli/ghostty-mcp`

The VT package must reach the public npm registry at the exact dependency version before the MCP package is published.

## Trusted publishing

Configure the same GitHub Actions trusted publisher on both npm packages:

| Setting | Value |
|---|---|
| Organization or user | `gkoreli` |
| Repository | `ghostty-vt-js` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

The GitHub repository has an `npm` environment restricted to the `main` branch. The workflow has `id-token: write`, runs on a GitHub-hosted runner, and uses npm 12.0.2. It requires no npm token and requests npm provenance for every automated release.

After both trusted publishers work, set each package's publishing access to require 2FA and disallow traditional tokens.

## Release

1. Update the package to a stable `X.Y.Z` version greater than every version already published for that package, and update its changelog. If MCP should consume a new VT version, update both package versions in the same commit.
2. Run `mise run check` and `bun run pack:dry-run`.
3. Commit and push the release source to `main`.

A push that changes either package manifest starts `publish.yml` at that exact commit. The workflow:

1. requires the release commit to be part of `main` and validates both manifest versions;
2. installs the frozen Bun workspace and runs the complete repository checks;
3. skips versions already present on npm, making retries safe;
4. refuses to publish a missing version unless it is greater than every stable version already published for that package;
5. verifies or creates each immutable package tag at the checked-out release source commit after detecting that package's version change in the push range;
6. publishes VT first and waits until the public registry resolves it;
7. verifies that Bun rewrote MCP's `workspace:*` dependency to the exact VT version;
8. publishes MCP and waits for public registry visibility.

A tag is created before its missing package version is submitted to npm. If publication fails, the tag preserves the exact release source for a safe rerun; it may temporarily exist before the corresponding registry version.

The `npm-publish` concurrency group uses GitHub's `queue: max` behavior. Up to 100 release runs wait without replacing an existing pending version, and only one release transaction runs at a time.

## Recovery

Prefer rerunning the failed workflow run, which preserves its original release commit. If that run is unavailable, dispatch **Auto tag and publish npm packages** from `main` with the full 40-character release commit SHA:

```bash
gh workflow run publish.yml --ref main -f release_commit=<40-character-main-commit>
```

The workflow rejects a commit outside `main`, skips versions already published, and accepts existing tags whose tagged manifest records the expected version. It can therefore resume after a partial npm publication or tag failure without overwriting registry versions or Git history. If a newer package version has already been published, recovery of a missing older version stops at the monotonic-version check rather than moving npm's `latest` tag backward.

A tag whose tagged manifest does not record the version in its name is a hard failure and must be corrected with a new package version. Never move or force-push a release tag.

## Initial package bootstrap

npm requires a package settings page before its trusted publisher can be configured. The initial `@gkoreli/ghostty-vt-js@0.3.2` and `@gkoreli/ghostty-mcp@0.3.0` versions were published interactively. New packages added to the monorepo require the same one-time bootstrap before they can join the automated workflow.

## Rollback

npm versions are immutable. Fix a bad release with a new version. Use npm deprecation for a version consumers should avoid; do not reuse or overwrite a published version.
