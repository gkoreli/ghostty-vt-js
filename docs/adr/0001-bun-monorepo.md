---
title: Bun monorepo for the VT runtime and MCP bridge
date: 2026-09-19
status: accepted
---

# Bun monorepo for the VT runtime and MCP bridge

## Context

The repository contains two independently useful but related deliverables:

- a JavaScript runtime that maps Ghostty's canonical `libghostty-vt` C ABI and adds browser, headless, protocol, server, React, and WASM surfaces;
- a macOS CLI and MCP server that controls Ghostty through its public AppleScript API and uses the VT runtime for styled reads.

They need one reproducible toolchain and one upstream Ghostty pin without forcing MCP dependencies or macOS constraints onto browser and headless consumers.

## Decision

Use a Bun workspace monorepo with two publishable packages:

```text
packages/
├── ghostty-vt-js/  # package: @gkoreli/ghostty-vt-js
└── ghostty-mcp/    # package: @gkoreli/ghostty-mcp; executable: ghostty-mcp
```

The repository root owns:

- Bun `1.4.2`, pinned by mise and mirrored in `package.json#packageManager`;
- `bun.lock` and the workspace graph;
- the pinned `vendor/ghostty` submodule;
- shared TypeScript settings, licensing, contribution guidance, and architecture records;
- dependency-ordered workspace commands through `bun --filter './packages/*' <script>`.

`@gkoreli/ghostty-mcp` depends on `@gkoreli/ghostty-vt-js` through `workspace:*`. Bun rewrites that dependency to the VT package version when publishing.

## Package boundaries

### `ghostty-vt-js`

This is the reusable runtime. Its public subpaths remain independently importable:

- `browser-terminal`
- `terminal-screen-emulator`
- `geometry`
- `protocol`
- `server`
- `react`
- `themes`
- `wasm`

TypeScript compiles the complete source tree to ESM plus declarations. Published exports point only at `dist` and the committed WASM artifact; consumers are not required to compile package-owned TypeScript.

### `ghostty-mcp`

This remains a thin macOS adapter:

- AppleScript transport and Ghostty operations;
- command-line interface;
- MCP stdio server;
- styled reads through `ghostty-vt-js`.

Its executable keeps the MCP SDK, Zod, and `@gkoreli/ghostty-vt-js` as normal package dependencies. In particular, preserving the VT package boundary keeps its WASM-relative loading contract intact instead of relocating the loader into the MCP bundle.

## Upstream ownership

`vendor/ghostty` stays at the repository root as one full-history submodule pinned to an explicit commit. The root mise tasks update, audit, and rebuild `packages/ghostty-vt-js/wasm/ghostty-vt.wasm`. Workspaces never carry separate Ghostty copies.

## Alternatives considered

### One package containing VT and MCP

Rejected. It would add MCP dependencies and a macOS-only AppleScript surface to browser, server, and headless runtime consumers. It would also make independent release and installation impossible.

### Split every VT surface into a package

Rejected for the initial public release. Browser, geometry, protocol, server, themes, React, and WASM already have subpath boundaries. Separate packages would multiply versions, manifests, release operations, and user choices without establishing a current need for independent versioning.

### Keep pnpm for package management and use Bun only as a runtime

Rejected. This repository is intentionally Bun-managed. One tool owns workspace installation, filtering, lockfile generation, runtime execution, and package dry runs.

## Consequences

- The workspace has two public packages and one lockfile.
- Package builds run in dependency order, so MCP always consumes the current VT build.
- The root submodule makes source checkout larger but keeps upstream ABI changes auditable.
- Publishing remains package-specific; the private root is never published.
- Additional packages require evidence that a subpath needs independent dependencies, ownership, or versioning.
