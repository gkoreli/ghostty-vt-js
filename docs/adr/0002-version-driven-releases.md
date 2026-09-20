---
title: Version-driven dependency-ordered npm releases
date: 2026-09-19
status: accepted
---

# Version-driven dependency-ordered npm releases

## Context

The monorepo publishes two independently versioned packages, and `@gkoreli/ghostty-mcp` depends on the exact packed version of `@gkoreli/ghostty-vt-js`. Manual package tags preserve that ordering only when the maintainer remembers to wait for npm registry propagation.

The `ghx` repository demonstrates a simpler release input: a version change on its main branch creates the release tag and continues to npm Trusted Publishing. Its manual dispatch path supports recovery for an existing release version. This repository needs the same version-driven operation with an additional dependency boundary.

## Decision

Use `.github/workflows/publish.yml` as one idempotent release transaction triggered by changes to either package manifest on `main` or by recovery dispatch for an explicit full commit SHA already on `main`.

- Package manifests are the release intent. A metadata-only or source-only push does not publish without a version change.
- One macOS job runs the frozen Bun install, complete checks, package dry runs, npm publication, registry waits, and tagging.
- Existing npm versions are skipped. A rerun resumes after partial publication instead of attempting to overwrite an immutable version.
- VT is published first. The workflow waits until the public registry resolves that exact version before considering MCP.
- Before MCP publication, the workflow inspects the Bun-generated archive and requires its rewritten VT dependency to equal the current VT manifest version.
- Each missing release tag is created at the checked-out release source commit after the workflow detects that package's manifest version changed in the push range, before a missing registry version is published. Existing tags are accepted only when the tagged package manifest records the expected version; tags are never moved. A failed publication can therefore leave a valid tag ahead of npm until the same release commit is rerun.
- Manual recovery runs only from the default branch, checks out an explicit full SHA, and requires that commit to be an ancestor of current `main`. This prevents recovery from tagging or publishing non-main branch state and preserves the source commit of a partial release.
- The workflow uses the GitHub `npm` environment restricted to `main`, OIDC `id-token: write`, npm 12.0.2, and no long-lived npm token.
- A repository-wide `queue: max` concurrency group serializes releases without replacing an intermediate pending version. GitHub does not guarantee dispatch order, so a missing version must be a stable `X.Y.Z` greater than every version already published for that package; a stale run fails before `npm publish` rather than moving the `latest` dist-tag backward.

## Alternatives considered

### Copy the `ghx` workflow literally

Rejected. Creating both package tags in one step would start independent tag-triggered publish jobs. MCP could run before VT publication or registry propagation, and GitHub does not guarantee the desired ordering between those workflow runs.

### Keep manually pushed package tags

Rejected as the normal path. The tag and manifest checks were safe, but the maintainer still had to coordinate dependency order and registry visibility manually. Manual dispatch remains available for recovery of an exact main-branch commit.

### Add a release-management dependency

Rejected. Changesets or another release manager could model a larger package graph, but two manifests and one dependency edge do not justify another tool, configuration format, or version source.

## Consequences

- Merging a new package version to `main` is the release action.
- A failed transaction can be rerun without republishing completed versions.
- Tags bind immutable package release intent to source before npm publication and can temporarily precede a registry version after a failed run.
- Both npm packages must trust the same `publish.yml` workflow and `npm` environment.
- The release queue retains up to 100 pending version commits. Releases beyond that operational bound are canceled rather than replacing an older pending run.
- If queued runs execute out of version order, the older missing version fails the monotonic gate and cannot change npm's `latest` dist-tag.
- Adding another dependent package requires an explicit publication and registry-wait position in the transaction.

## Evidence

- **[ghx auto-tag workflow](https://github.com/gkoreli/ghx/blob/mainline/.github/workflows/auto-tag.yml)** — establishes the version-change trigger, automatic tag creation, manual recovery path, and npm OIDC publication pattern adapted here.
- **[GitHub Actions concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)** — default concurrency replaces an existing pending run; `queue: max` retains up to 100 pending runs and serializes them without cancellation.
- **[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)** — requires a supported CI provider, `id-token: write`, and a recent npm CLI; it removes long-lived registry tokens and generates verifiable provenance.
- **Initial registry observations on 2026-09-19** — both first releases appeared on their owner package pages before `npm view` and clean installation succeeded. The workflow therefore waits for public registry resolution instead of treating a successful publish response as dependency availability.
