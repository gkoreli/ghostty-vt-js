# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Setup

```bash
git clone --recurse-submodules https://github.com/gkoreli/ghostty-vt-js.git
cd ghostty-vt-js
mise trust
mise install
mise run install
mise run check
```

## Requirements

- Keep `@gkoreli/ghostty-vt-js` independent of application policy and MCP dependencies.
- Keep `@gkoreli/ghostty-mcp` macOS-specific and thin; reusable terminal behavior belongs in the VT package.
- Add tests for behavioral changes.
- Preserve third-party source headers and update `THIRD_PARTY_NOTICES.md` when adding derived or redistributed code.
- Do not update `vendor/ghostty` automatically. Use `mise run wasm:update`, review the C-header diff, update TypeScript declarations, and commit the submodule pin and rebuilt WASM together.
- Run `mise run check` before opening a pull request.

## Commits

Use focused commits with direct messages. Do not include generated dependency directories or Ghostty build output.
