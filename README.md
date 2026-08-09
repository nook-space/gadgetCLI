# gadgetCLI

Make and push apps ("gadgets") to a self-hosted
[Cloudflare OS](https://github.com/cloudflare/cloudflare-os) instance from the
terminal: real files, git, your own editor, your own coding agent. The
workshop today is browser-only; gadgetCLI gives it a headless lane.

**Status:** vision note. `PLAN.md` governs the MVP and supersedes details here
(v1 scope, the doctor "version handshake", the harness). An independent community
project, not affiliated with Cloudflare.
**Feasibility:** verified against the cloudflare-os source (the frontend's own
RPC surface in `packages/workshop-shared/src/api.ts` and the documented
`.gadget` archive format in `docs/blueprints.md`). No browser automation, no
scraping — v1 is a pure client of your instance.

## Design principles

- **Two masters, one truth.** The instance's Yjs doc is truth; local files are
  a working copy. The CLI behaves like git against a remote — pull, diff,
  version-checked push — never like a deployer that overwrites what the in-app
  agent or a collaborator edited an hour ago.
- **Code is pushable; authority is not.** The CLI moves code and *requests*
  bindings; anything that grants capability (OAuth connects, binding
  approvals) ends in a URL the human opens. A terminal tool must not become
  the ambient-authority hole in Cloudflare OS's capability model.
- **Two lanes, one hedge.** A live RPC lane for interactive dev, and the
  documented `.gadget` archive as the stable interchange lane. The archive is
  the only on-disk surface upstream has committed to; when the internal API
  shifts, the archive lane and CI keep working.
- **Local-first dev loop.** `workerd` installs from npm; a tiny harness gives
  a run-test loop without driving a full workshop instance.
- **Agent-native from day one.** The skill is a deliverable equal to the
  binary; a terminal coding agent is the primary persona, the human with an
  editor the second.

## Architecture (four small packages)

| Package | Role |
|---|---|
| `gadget-cli` | Commands; talks to instances only through the adapter |
| `gadget-remote` | The instance adapter: capnweb-over-WebSocket client, auth, API-version handshake — the *only* code that knows the upstream API |
| `gadget-harness` | Local dev runtime: workerd config loading `server.js` as a DO, serving `client.js` with a Cap'n Web bridge shim, `env` from mocks |
| `gadget-skill` | Teaches agents the gadget idiom (DO class, Cap'n Web, no fetch, `dup()`/dispose discipline, storage-not-memory, the restore pattern) plus the CLI verbs |

## Project shape on disk

```
my-tracker/
  gadget.json        # manifest: title, files, binding shapes, instance/gadget refs
  server.js          # the DO class `Gadget`
  client.js          # the iframe UI
  README.md          # upstream convention: agent-facing gadget docs
  mocks/env.js       # local-dev binding mocks (harness only, never pushed)
  .gadget/state      # base Y.Doc + version from last pull (the "git index"), gitignored
```

`gadget.json` is the CLI's file, not the instance's: binding *shapes* (name,
vendor, resource pattern, annotation — what a blueprint records) plus
per-profile instance and gadget IDs. It is never pushed.

## Command surface

- **Identity:** `login <url>` (password / OAuth / Cloudflare Access; token to
  OS keychain; named profiles) · `doctor` (reachability, auth mode,
  API-version handshake, plain statement of what won't work).
- **Core:** `new [--from <blueprint-url|.gadget>]` · `list` · `pull` · `diff`
  · `push [--new | --as-chat | --force]` · `open`.
- **Run & observe:** `dev` (local workerd harness, hot reload, mocked
  bindings — bannered as such) · `test` (Node tests against the harness DO
  over Cap'n Web) · `logs [--follow]`.
- **Capabilities:** `bind list` · `bind request <name> --vendor … --resource …`
  (stages the request, prints the workshop URL; the CLI's job ends at the
  doorstep, on purpose).
- **Stable lane:** `pack` / `unpack` (tree ⇄ `.gadget`) · `blueprint publish
  [--update <id>]` · `install <url>` · `release` (pack + publish + tag).

## The flows, against the real API

**Transport.** One WebSocket: `wss://<instance>/api`, spoken with
`newWebSocketRpcSession<PublicApi>()` from the `capnweb` npm package — the
same call the browser frontend makes; it runs in Node.

**Login.**
1. `getServerConfig()` → which sign-in modes this deployment offers.
2. Password mode: the API doc publishes the client-side hashing spec (argon2id
   over `SERVICE_SALT` + username; the server never sees the password) →
   `login(username, passwordHash)` → token → keychain; later sessions call
   `authenticate(token)` → `AuthenticatedApi`.
3. OAuth mode: `startGatekeeperLogin(vendorId)` → `{url, attempt}` — print the
   URL, the human signs in in a browser, `attempt.wait()` resolves with the
   token. A device-flow-shaped API already sitting there.
4. Access mode: `authenticateFromCfAccess()` with Access service-token headers
   on the WebSocket request.

**Pull.**
1. `authenticate(token)` → `openGadget(id)` → `Overseer` stub (pipelined, one
   round trip).
2. Load (or create) the local Y.Doc; `subscribeToCode(subscriber,
   fromVersion)` — the server streams ordered incremental `CodeUpdate`s and
   calls `ready()` when caught up; apply synchronously, then dispose.
3. Materialize the gadget's code root (filename → text) to disk; save the
   Y.Doc snapshot + version in `.gadget/state` as the merge base.
   Pulls are incremental by construction because they ride the same CRDT sync
   the live editor uses.

**Push.**
1. Apply local files onto the base Y.Doc (v1: whole-file set per changed file;
   diff-splice later for prettier history).
2. Safety: re-subscribe from the base version; any updates you lack mean the
   remote moved → refuse with "pull first" (pull at that moment is a genuine
   CRDT merge, not a clobber). `--force` exists and says what it tramples.
3. Encode the local delta as one Yjs update → `updateCode(update)`. It lands
   exactly as the in-app editor's keystrokes land: history, live cursors, and
   the in-app agent's view stay coherent.
4. `--new`: `newGadget()` → `createGadget(title)` → push into the fresh root.
5. `--as-chat`: `updateCode(update, chatId)` stages the change as a chat's
   *proposed* edit for in-UI review — the polite mode for shared gadgets.

**Publish (blueprints as the release artifact).**
1. `pack`: build a fresh Y.Doc with one insert per file (upstream's documented
   minimal-snapshot encoding), gzip, prepend the documented header (magic
   `0xec2e2d3a2300e317`, format version, metadata JSON) → a `.gadget` file.
2. `blueprint publish`: `importBlueprint(archiveStream)` → blueprint ID; the
   shareable page is `https://<instance>/blueprint/<id>`; recipients
   instantiate their own copy and wire their own bindings — the capability
   model fully respected.
3. `install <url>`: `newGadgetFromBlueprint(id, …)`, deferring binding
   assignment to the UI where connects need OAuth.
4. `PublicApi.downloadBlueprint(id)` is **unauthenticated** by upstream's
   design — so `gadget new --from <any instance's blueprint URL>` works with
   zero login. Blueprints are already a cross-instance package format; the CLI
   gives it a package manager's verbs.

## Confirmed vs. needs-a-spike

- **Confirmed in upstream source:** the `/api` WebSocket entry; all three auth
  flows with the published hashing spec; `openGadget` / `newGadget` /
  `listGadgets`; ordered incremental code sync with `ready()`;
  `updateCode` including the chat-mode parameter; `importBlueprint`;
  unauthenticated `downloadBlueprint`; `getUiBundle` for a preview command.
- **Spike before believing:** exact code-root naming on multi-gadget
  workspaces (legacy `""` root vs. decimal workpiece IDs — exposed in
  metadata, get it right); headless chat creation for `--as-chat`; Node-side
  capnweb + argon2 ergonomics end to end against a `pnpm run-local` instance.
- **Standing risk:** this is the *internal* frontend API (~2,900 lines, under
  heavy development, no stability promise). All contact stays inside
  `gadget-remote`; `doctor` does a version handshake; the archive lane keeps
  `pack`/`publish`/CI working while the live lane chases upstream changes.

## Risks, named

- **API churn** → adapter isolation + version handshake + archive-lane
  fallback.
- **Harness fidelity** → mocks are not real gatekeepers; `dev` banners it
  ("mocked bindings — behavior differs from the instance").
- **Shared-gadget stomping** → base-version refusal, and suggest `--as-chat`
  when collaborators exist.
- **Auth diversity across forks** → pluggable auth in the adapter, per-profile
  configuration.

## v1 scope

`login · list · new · pull · diff · push · pack · blueprint publish · install
· open · logs · doctor` — plus the skill and the harness.
