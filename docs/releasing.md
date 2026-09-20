# Releasing

The repository publishes two independent npm packages:

- `@gkoreli/ghostty-vt-js`
- `@gkoreli/ghostty-mcp`

The VT package must exist at the exact dependency version before the MCP package is published.

## First release

A package needs an npm settings page before its GitHub trusted publisher can be configured. Publish each package once from a clean checkout with an interactive OTP.

```bash
mise run check

cd packages/ghostty-vt-js
archive=$(bun pm pack --destination /tmp --quiet)
npm publish "$archive" --access public --otp=<current-code>

cd ../ghostty-mcp
archive=$(bun pm pack --destination /tmp --quiet)
npm publish "$archive" --access public --otp=<current-code>
```

Verify each version before proceeding:

```bash
npm view @gkoreli/ghostty-vt-js@0.3.2 version
npm view @gkoreli/ghostty-mcp@0.3.0 version
```

## Configure trusted publishing

After the first release, open each package on npm and configure the same GitHub Actions trusted publisher:

| Setting | Value |
|---|---|
| Organization or user | `gkoreli` |
| Repository | `ghostty-vt-js` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

The workflow has `id-token: write`, runs on a GitHub-hosted runner, and uses npm 12.0.2. It requires no npm token and produces npm provenance automatically.

After both trusted publishers work, set each package's publishing access to require 2FA and disallow traditional tokens.

## Subsequent releases

1. Update the package version and changelog.
2. Run `mise run check` and `bun run pack:dry-run`.
3. Commit and push the release source.
4. Create and push one package tag:

```bash
git tag ghostty-vt-js-vX.Y.Z
git push origin ghostty-vt-js-vX.Y.Z

# Only after the required VT version is visible on npm:
git tag ghostty-mcp-vX.Y.Z
git push origin ghostty-mcp-vX.Y.Z
```

`publish.yml` rejects tags whose version does not match the selected package manifest. MCP publication also checks that its exact VT dependency is already available from npm.

## Rollback

npm versions are immutable. Fix a bad release with a new version. Use npm deprecation for a version consumers should avoid; do not reuse or overwrite a published version.
