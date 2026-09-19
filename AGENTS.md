# ghostty-vt-js contributor guidance

## Scope

This Bun monorepo publishes two independent npm packages:

- `@gkoreli/ghostty-vt-js`: reusable `libghostty-vt` runtime and integrations;
- `@gkoreli/ghostty-mcp`: macOS AppleScript CLI and MCP adapter.

Do not move application authentication, authorization, process policy, or product UI into the VT package.

## Toolchain

- Bun 1.4.2 owns installation, workspaces, scripts, and `bun.lock`.
- Mise pins Bun and Zig and exposes repository commands.
- Zig must match `vendor/ghostty/build.zig.zon` when the submodule advances.
- Do not use npm, pnpm, or Yarn to mutate dependencies or generate lockfiles.

## Validation

Run `mise run check` for TypeScript build, type checking, package tests, and CLI smoke tests. Run `mise run demo` for browser changes. Rebuild WASM only through the root mise tasks.

## Upstream changes

`vendor/ghostty` is a full-history, commit-pinned submodule. Use `mise run wasm:update`, inspect the C API commits and header diff, then update wrappers, declarations, tests, the submodule pin, and the committed WASM atomically.

## Licensing

Preserve source-specific attribution headers. Update `THIRD_PARTY_NOTICES.md` when redistributing or deriving from another project. Do not imply endorsement by the Ghostty project.
