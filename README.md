# gadgetCLI

Make and push apps ("gadgets") to a self-hosted
[Cloudflare OS](https://github.com/cloudflare/cloudflare-os) instance from the
terminal: real files, git, your own editor, your own coding agent. The workshop
is browser-only; gadgetCLI gives it a headless lane.

An independent community project, not affiliated with Cloudflare.

## Principles

- The instance's Yjs doc is truth; local files are a working copy. The CLI behaves
  like git against a remote — pull, diff, version-checked push — never a deployer.
- Code is pushable; authority is not. Anything granting capability (OAuth, connections)
  ends at a URL a human opens.
- Pure API client: the same capnweb WebSocket the browser frontend speaks. No scraping.
- Agent-native: every flow has a non-interactive lane, `--json` where it matters,
  and errors are one cause plus one next step.

## A gadget is not an ordinary Workers project

Both run on workerd, Cloudflare's Workers runtime. The project shapes differ.
Cloudflare OS supplies everything except your files — write the gadget shape natively:

- Ordinary Worker: `wrangler.toml`, `export default { fetch }`, own routing, hosting, deploy.
- Gadget: `server.js` exports one Durable Object class named `Gadget`. No config, no fetch
  handler — the platform routes; your public API is the class's methods.
- `client.js` builds the whole UI in a sandboxed iframe and calls the server through the
  global `gadget` RPC stub. No `index.html`, no bundler, no build step.
- No deploy step: `gadget push` lands code in the workspace's shared doc; the instance
  restarts the gadget with it.
- Gadget code cannot reach the network; external services arrive as bindings a human wires
  in the workshop UI.

This is the same shape the web editor and the in-app agent write — the terminal and the
browser edit ONE shared document, in both directions (`push` up, `pull` down, live).
The scaffold (`gadget new`) and `skill/SKILL.md` teach it; code in the ordinary-Worker
shape will not run on the instance.

## Install

**Prerequisites:** Node >= 22 — the global `WebSocket` the transport needs arrived in 22.

If (and only if) your instance sits behind **Cloudflare Access**, you also need
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(`brew install cloudflared` on macOS). The CLI detects the gate and asks for it only then,
so nobody installs it who does not need it.

```sh
npx @nook-space/gadget-cli --help       # no install
npm install -g @nook-space/gadget-cli   # then: gadget --help
```

From source:

```sh
git clone https://github.com/nook-space/gadgetCLI && cd gadgetCLI
pnpm install && pnpm build
node dist/cli/main.js --help            # or: pnpm link --global → gadget --help
```

The command is `gadget` however you install it. `gadget --help` (and
`gadget <command> --help`) lists every command — enough for an agent to discover the
surface on its own.

## Teach your coding agent

The CLI ships an agent skill (verbs + the gadget idiom). Any shell-capable agent can
drive `gadget`; the skill just teaches it how.

```sh
gadget skill                       # print the skill to stdout
gadget skill install               # place it where Claude Code looks (~/.claude/skills/gadget/)
gadget skill install --path .claude/skills/gadget/   # or a project dir, committed for the team
gadget skill refresh               # re-copy it everywhere it was installed
```

Installs are recorded, so `gadget skill refresh` updates every copy after a CLI update —
a copy is a snapshot, and a stale skill teaches an agent the wrong commands.

## Staying up to date

A cached background check notices new releases and prints one line to stderr — never for
machines (non-TTY, CI, `--json`, `GADGET_NO_UPDATE_CHECK`/`NO_UPDATE_NOTIFIER`). It never
self-updates: run `gadget update` (or `--check`). For npx, Homebrew, or a source checkout
it prints that install's own command instead of guessing.

## Quickstart

```sh
# sign in — one login per instance, kept as a named profile
gadget login https://os.your.dev --create --username you  # password (prompt, or GADGET_PASSWORD)
gadget login https://os.your.dev --vendor github          # "Continue with X": prints a URL to open
gadget login https://os.your.dev                          # behind Cloudflare Access: detected, via cloudflared
gadget doctor                                             # reachability, sign-in modes, auth state

gadget new tracker && cd tracker  # scaffold: server.js, client.js, README.md
gadget push --new                 # create workspace + gadget, link this directory
gadget open                       # the workspace URL (auto-opens a browser on mac/Linux TTYs)

# the loop
vim server.js
gadget status && gadget diff
gadget push                       # refuses if the remote moved: pull, resolve, push
gadget pull                       # aborts whole rather than clobber dirty files
gadget logs                       # live console stream (Ctrl-C stops)
```

## Share it

```sh
gadget blueprint publish          # pushed code → https://<instance>/blueprint/<id>
gadget blueprint publish --update <id>   # bump the same URL to the current code
gadget pack                       # offline .gadget archive for git/CI
gadget new my-copy --from <blueprint-url>  # start from any instance's blueprint, no login
gadget install <url|id>           # your own instance of a zero-binding blueprint
```

Collaborators keep their own credentials: blueprints carry code and binding *shapes*,
never connections.

## Behavior worth knowing

- Conflicts: push refuses when the same gadget changed remotely (exit 4); pull refuses
  rather than overwrite local edits. Different files: pull, then push. Same file on both
  sides: copy yours aside, `pull --force`, merge, push. Identical content never conflicts.
  `--force` is last-writer-wins; the losing edit survives only in server history.
- Files are UTF-8 text ≤ 1 MiB. Dotfiles, `node_modules/`, `mocks/`, and `*.gadget`
  archives never sync, in either direction.
- Sessions: one login per instance profile (`--profile` to switch, one login per instance);
  tokens live in `~/.config/gadget/config.json` (0600). `gadget logout [--all]` clears them
  locally (no server-side revoke yet).
- Cloudflare Access instances work: `gadget login <url>` detects the gate and uses
  `cloudflared` for the session (`brew install cloudflared`, one browser hop, then silent
  refresh). An Access profile stores **no token at all** — identity is proven per
  connection. Headless CI against an Access instance is not possible: Access service
  tokens carry no email claim, which the instance requires.
- Exit codes: 0 ok · 1 error · 2 usage · 3 auth · 4 conflict · 5 rpc.

## Development

```sh
pnpm check                        # typecheck + lint
pnpm test                         # unit; add GADGET_TEST_URL=http://localhost:8787 for live
```

Live tests need a local instance:

```sh
git clone https://github.com/cloudflare/cloudflare-os && cd cloudflare-os
corepack pnpm run-local          # serves http://localhost:8787
```

Design notes and trade-offs: `DESIGN.md`. Roadmap: `idea.md`. The agent skill lives in
`skill/SKILL.md`.
