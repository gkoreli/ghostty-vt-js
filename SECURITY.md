# Security

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. If that feature is unavailable, contact the repository owner privately through the address on the maintainer's GitHub profile.

## Trust boundary

`@gkoreli/ghostty-vt-js` implements terminal emulation and session mechanics. It does not authenticate users, authorize sessions, or sandbox processes.

`@gkoreli/ghostty-mcp` can read terminal content, send commands, create terminals, and invoke Ghostty actions with the current user's privileges. Configure it only in MCP clients you trust.

Applications exposing a PTY over a network must provide, at minimum:

- authentication and per-session authorization;
- origin validation for browser WebSocket connections;
- encrypted transport outside loopback;
- bounded frame sizes, scrollback, sessions, and process lifetime;
- explicit policy for executable commands and working directories;
- audit logging appropriate to the application;
- consent checks before honoring terminal clipboard or notification requests.

The demonstration server is for local development. Do not expose it to an untrusted network.

## Supported versions

Until the first public release, security fixes apply only to the latest commit on `main`. A version support table will be added when releases begin.
