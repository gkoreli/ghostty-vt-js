# Architecture decision records

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-bun-monorepo.md) | Accepted | Use a Bun monorepo with independently publishable VT and MCP packages |
| [0002](0002-version-driven-releases.md) | Accepted | Bind immutable tags to versioned source and publish in VT-before-MCP order |
| [025](025-ghostty-mcp.md) | Accepted | Expose Ghostty's AppleScript API through a CLI and MCP server |
| [025.1](025.1-ghostty-mcp-north-star.md) | Accepted | Treat the terminal as an observable and controllable agent surface |
| [026](026-browser-terminal-architecture.md) | Accepted | Map canonical libghostty-vt effects, render state, memory, and modules directly |
| [027](027-terminal-geometry-session-authority.md) | Accepted | Make the session host authoritative for geometry and state replay |
| [027.1](027.1-terminal-layout-feedback-isolation.md) | Accepted | Isolate terminal painting from measured browser layout |
| [028](028-gpu-renderer-seam.md) | Accepted | Add an accelerated renderer behind an engine-independent interface |
| [028.1](028.1-hand-roll-with-references-engine-blind-core.md) | Accepted | Keep the GPU core engine-blind and feed it typed frame data |
| [028.2](028.2-synchronized-output-frame-hold.md) | Accepted | Honor synchronized-output mode in the frame scheduler |

The records retain historical alternatives and measurements. Current package behavior and commands are documented in the root README, package READMEs, and `docs/architecture.md`.
