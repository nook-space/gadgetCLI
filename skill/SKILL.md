---
name: gadget
description: Build and publish gadgets to a self-hosted Cloudflare OS instance from the terminal — pull, edit, push real files with the gadget CLI, then share them as blueprints.
---

# Working on gadgets with the gadget CLI

A gadget is a small app on a Cloudflare OS instance. Its code is three files or so.
The instance runs it; you edit real files locally and sync them with the CLI.

## Project shape

- `server.js` — a Durable Object class, exported as `Gadget`. All server state and logic.
- `client.js` — the UI. Runs in a sandboxed iframe; builds ALL DOM itself (no index.html).
- `README.md` — describe the gadget for the next agent.
- `gadget.json` — the CLI's link to the instance. Do not edit by hand. Commit it to git.
- `.gadget/` — sync state. Never touch. The scaffold writes a `.gitignore` covering it;
  run `git init` yourself if you want history (recommended — git is the revert story).

## Sign in once

- `gadget login <url> --create --username <name>` with the password in `GADGET_PASSWORD`.
- OAuth instances: `gadget login <url>` prints a URL — give it to the human and wait.
- `gadget doctor` verifies everything and says what does not work.

## The edit loop

1. `gadget new <dir>` (scaffold) or `gadget pull <workspace-id>` (existing; see `gadget list`).
2. Edit files. `gadget status` and `gadget diff` show your changes against the base.
3. `gadget push` uploads. First time: `gadget push --new` creates the workspace and links it.
4. `gadget open` prints the workspace URL. `gadget logs` streams live console output.

Rules the CLI enforces — work with them, not around them:

- Push refuses (exit 4) when the remote changed the same gadget. Different files: run
  `gadget pull`, then push. Same file changed on both sides: pull refuses too — copy your
  version of the listed files aside, run `gadget pull --force`, merge by hand, then push.
  Identical content never conflicts.
- Pull refuses (exit 4) rather than overwrite your dirty files. `--force` overwrites — use it
  only when the human said so; the losing edit survives only in server history.
- Files are UTF-8 text ≤ 1 MiB. Dotfiles, `node_modules/`, `mocks/`, `*.gadget` never sync.

## Publish and reuse

- `gadget blueprint publish` — publish the PUSHED code as a blueprint; prints a share URL.
  Requires a clean, current tree. `--update <id>` bumps an existing blueprint at the same URL.
- `gadget pack` — write a `.gadget` archive (offline artifact for git/CI).
- `gadget new <dir> --from <blueprint-url|file>` — start from any instance's blueprint. No login.
- `gadget install <url|id>` — create your own instance of a zero-binding blueprint.
  Blueprints that need connections must be instantiated in the browser — hand the URL over.

## Writing gadget code (the instance's idiom)

This is NOT the ordinary Cloudflare Workers shape. Do not add wrangler config, a fetch
handler, an index.html, or a build step — that shape will not run here. The platform
supplies routing, hosting, sandboxing, and deploy; you supply only the files below.

- `server.js` MUST export the class as `Gadget`, extending `DurableObject` from
  `"cloudflare:workers"`. No fetch handler; the platform routes for you.
- Persist ALL state in `this.ctx.storage` (KV or SQL). Memory is cache only —
  the server restarts on every push.
- `client.js` talks to the server through the global `gadget` RPC stub: a method on the
  class is a call on the stub. Await everything.
- Gadget code cannot reach the network. External services arrive as bindings in `env`,
  wired by the human in the workshop UI — ask for connections, never fake them.
- Server-to-client callbacks: `.dup()` the stub you keep, watch `onRpcBroken`, and
  implement `[Symbol.dispose]()`. Long-lived callbacks need the `ctx.restore()` pattern.
- Real-time collaboration is normal: assume several clients, broadcast via storage + polling
  or callback lists.

## Conduct

- Never `--force` over a shared gadget without the human's explicit say.
- Anything that grants authority (OAuth, connections) ends at a URL the human opens.
- Prefer small pushes with clean status; the web editor and other agents see your changes live.

## Exit codes and machine output

0 ok · 1 error · 2 usage · 3 auth (log in) · 4 conflict (the hint names the fix) · 5 rpc/instance.
`--json` on `list`, `status`, `doctor`, `whoami` (the flag works in any position).
Errors print `error:` + one `hint:` line.
