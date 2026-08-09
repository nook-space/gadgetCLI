# idea.md — after the MVP

One line per idea. Promote an idea by moving it into PLAN.md.

## Commands and flows

- `gadget dev` / `gadget test` — local workerd harness with mocked bindings and hot reload.
- `push --as-chat` — stage the push as a chat draft for in-UI review (`newChat(msg, null)` + `finalizeChatDraft`).
- `gadget release` — push + blueprint update + git tag in one verb.
- `gadget clone <url>` — pull straight into a new directory.
- `push --watch` — mirror local saves to the instance continuously.
- `bind list` / `bind add --account --resource-url` — headless binding when the account is already connected.
- `bind request` — stage a binding shape and print the workshop URL (the doorstep).
- `gadget history` / `pull --at-version` — browse the update log; restore old versions.
- `gadget diff --remote` / `pull --dry-run` — see base↔remote before pulling; real conflict resolution.
- `gadget restore <file>` — discard a local edit back to the base (no such verb today).
- `gadget call <method> [args]` — invoke a gadget's server method headlessly (the tests' wake lane).
- `logs`: auto-reconnect on drop; `--gadget` filter.
- `gadget export-pdf` — wrap upstream `exportPdf()`.
- `gadget preview` — fetch `getUiBundle()` and serve it in a local browser shell.
- Multi-gadget workspaces — several roots in one project directory.

## Auth and security

- Cloudflare Access mode — user JWT via `cloudflared access token`, `ws` socket with Origin header.
- OS keychain token storage.
- `gadget logout` — delete the local token (expected on shared/hosted machines).
- `gadget logout` — delete the local token (server-side revocation needs upstream work).

## Engineering

- Diff-splice pushes for minimal CRDT history.
- Binary assets in gadgets — needs an upstream story first (roots are Y.Text today).
- Binding shapes in `gadget.json` → blueprint metadata on `pack`.
- Blueprint screenshot upload on publish.
- MCP mode — expose the CLI verbs as tools for non-CLI agents.
- Single-file build; npm + Homebrew distribution.
- Workspace split: `gadget-remote` as a reusable client library.

## Upstream asks

- An API version constant in `ServerConfig` for a real handshake.
- An HTTP GET route for blueprint archives (today download is RPC-stream only).
- Token expiry, revocation, and session listing.
- Stored (not only live) gadget logs.
- Service-token support in Access mode (`common_name` accepted, not only `email`).
