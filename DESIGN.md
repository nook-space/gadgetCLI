# gadgetCLI — design notes

Why the tool is shaped the way it is: the model it follows, the algorithms that
matter, and the trade-offs taken with eyes open. For usage, see the README.

## Goal

Ship a CLI that moves gadget code between local files and a hosted Cloudflare OS instance.
A terminal agent or a human can create, pull, edit, push, and publish gadgets without a browser.
Auth stops at a URL the human opens. The CLI never holds third-party credentials.

## Architecture

One npm package. Four internal modules. No runtime dependency on upstream code.

- `src/cli/` — commands, output, errors. No transport/capnweb mechanics; typed RPC calls only.
- `src/remote/` — capnweb session, vendored API types, auth. The only module that knows upstream.
- `src/sync/` — Y.Doc state, materializer, diff, push delta builder.
- `src/archive/` — `.gadget` codec (header + gzip + Yjs snapshot).
- `skill/SKILL.md` — teaches an agent the CLI verbs and the gadget idiom.

Runtime deps: `capnweb`, `yjs`, `hash-wasm`, `commander`. Nothing else.

## Data on disk

- `~/.config/gadget/config.json` — profiles `{name → {url, token}}` + skill install paths. Mode 0600.
- `~/.config/gadget/update-check.json` — cached registry answer (checkedAt + latest).
- `gadget.json` — project manifest: profile, workspace id, gadget (workpiece) id, title.
- `.gadget/state.json` — base Y.Doc (base64 V2 update) + last synced version. Gitignored.
- Tracked files = gadget root map keys ∪ local files, minus ignore set.
- Ignore rule (BOTH sides — local tree and doc): `gadget.json`, `node_modules/`, `mocks/`
  (top level) + dot-entries and `*.gadget` archives everywhere. Ignored doc entries are
  never materialized, diffed, or deleted by a push. `mocks/` is reserved for the harness.
- The manifest records the gadget's `filesRoot` at link time; offline commands never guess it.

## Core algorithms

Pull:
1. Open the workspace. Read the workpiece list. Resolve the workpiece and its `filesRoot`.
2. Subscribe to code from the stored version. Apply updates until `ready()`. Dispose.
3. Conflict rule: if any file changed remotely AND is dirty locally, abort the whole pull.
   Write nothing. Keep the old base. List the conflicting files. `--force` overwrites instead.
4. No conflict: write changed files, then save the new base doc and version.
   Never save a new base without materializing it (a skipped file must never advance the base).

Push:
1. Fetch remote updates and fast-forward a copy of the base (same as pull, no file writes).
2. Refusal rule: refuse iff any tracked file's text differs before vs after the fast-forward.
   Never key off update presence or version numbers — updates span other workpieces too.
3. Apply local files onto the base doc in one transaction. Capture `updateV2` events.
4. Whole-file replace per changed file. Delete removed files. Merge events into one update.
5. Send `updateCode(update)`. Resync the base so state matches the server.
   Identical remote/local text is convergence, never a conflict (crash windows self-heal).
   If foreign edits landed inside the push window: warn AND keep the pre-resync base,
   so the next push refuses until a real pull materializes them.

Push `--new`: create the workspace, then the gadget; both get the project title. Write ids to `gadget.json`.

Safety rules:
- Reject file names that are absolute or contain `..`.
- Text only: refuse non-UTF-8 file content (roots are Y.Text upstream). Refuse files over 1 MiB.
- Write `state.json` and the config atomically (temp file + rename).
- The freshness check is advisory. A same-file race is last-writer-wins; see the trade-off ledger.

## Command surface

- `gadget login <url>` — sign in with password or "Continue with X". Store the token.
- `gadget logout [--all]` — clear the stored token for a profile (local only; no server revoke).
- `gadget doctor` — check reachability, auth, and API health. Say what does not work.
- `gadget whoami` — print the signed-in identity.
- `gadget list` — list workspaces on the instance.
- `gadget new <dir> [--from <blueprint-url|file>]` — scaffold a gadget project locally.
- `gadget pull [id] [--gadget <workpiece>]` — download gadget code. Link the directory on first pull.
- `gadget status` / `gadget diff` — show local changes against the pulled base.
- `gadget push [--new] [--force]` — upload local changes as one CRDT update.
- `gadget open` — print (and open) the workspace URL.
- `gadget logs` — stream the workspace's live console logs.
- `gadget pack` — convert a project tree to a `.gadget` archive. (`new --from <file>` is the inverse.)
- `gadget blueprint publish` — publish a blueprint. Print its share URL.
- `gadget install <url|id>` — create an own instance from a blueprint (zero-binding only).
- `gadget skill` / `skill install [claude-code] [--path <p>]` / `skill refresh` — the agent skill.
- `gadget update [--check]` — explicit update; a cached background check notifies passively.

## Test strategy

- Unit tests: archive codec, delta builder, path guards, state codec. No network.
- Integration tests: against `pnpm run-local` cloudflare-os on localhost:8787.
- Fresh identities per test run. Never assume a clean server.
- One cross-validation test per format we share with upstream.

## Assumption ledger

- The instance runs current cloudflare-os main; the integration workflow verifies this nightly.
- Password, gatekeeper OAuth, or Cloudflare Access sign-in is enabled.
- Node ≥ 22 provides the global WebSocket; openSession preflights it with a clear error.
- capnweb from Node: RPC, callback subscriptions, and ReadableStream transfer in both
  directions are all proven live (the Phase 4 spike passed; no fallback needed).
- Session tokens do not expire; one login per profile is enough.
- `.gadget` archive format v1 is stable per cloudflare-os `docs/blueprints.md`.
- `WorkpieceSummary.filesRoot` is authoritative for root naming.
- A project links one workspace and one gadget; more gadgets need an explicit `--gadget`.
- Provisional-workspace reaping is documented upstream but not found implemented; the CLI
  never relies on it — push --new links the directory before the first update lands.
- Gadget files are UTF-8 text (upstream roots are Y.Text; binaries do not exist there today).
- Usernames: alphanumeric starting with a letter; the server lowercases for routing and
  throws (not null) on invalid shapes; login is case-sensitive to the signup-typed name.

## Decision ledger

- One package with module boundaries; split into workspace packages only when the harness lands.
- Vendor type-only API definitions; no build or runtime coupling to the upstream repo.
- Spec'd runtime values (SERVICE_SALT, openGadget error codes) live in remote/constants.ts only.
- Vendored deviation policy: member subsets allowed; rewrites forbidden; any→unknown deliberate.
- Token store is a 0600 config file; keychain comes later.
- State is one JSON file with the base doc as base64, written atomically.
- Pull conflicts abort the whole pull; no per-file skip; a stale base never advances silently.
- Push refusal = tracked-file text changed across the fast-forward; never version arithmetic.
- v1 push does whole-file replaces; diff-splice comes later.
- After push, resync from the server; warn when foreign updates landed during the window.
- `publish` prefers the gadget-backed lane (versioned, stable URL) and requires a clean, pushed tree.
- Publish's currency probe is advisory like push's freshness check — it inherits the same race.
- Untrusted archive metadata is normalized on parse; untrusted strings are sanitized before printing.
- Archives are create-only on the instance (`importBlueprint` mints a new id every time).
- `install` runs headless only for zero-binding blueprints, by design.
- `unpack` is not a verb; `new --from <file>` is the inverse of `pack`.
- Every RPC failure prints the cause and one next step; "no such method" suggests a CLI upgrade.
- Login dispatch is a pure planLogin(config,opts) decision; --create is refused (not ignored)
  on OAuth-only instances, where first sign-in is the signup.
- Use upstream's typed error codes (openGadget) in the renderer; distinguish null from thrown.
- One RPC session per command; global deadline; dispose stubs in reverse order.
- Cloudflare Access is detected, not configured: it is a property of the deployment.
  `access` and `token` are orthogonal on a profile (identity vs. network gate).
- Update checks run detached and one run behind; the CLI never self-mutates — `gadget update` is explicit.
- The notice is human-only: suppressed for non-TTY stdout, CI, --json, and the opt-out env vars.
- Skill installs are recorded so `skill refresh` reaches every copy; copies are snapshots, not links.
- Human-first output on stdout; `--json` for agents on list/status/doctor/whoami.

## Trade-off ledger

- Vendored types can drift ↔ zero coupling to upstream; drift surfaces as clear runtime errors.
- File token store is weaker than keychain ↔ zero native deps; 0600 limits exposure.
- Whole-file replace makes noisier CRDT history ↔ far simpler; history stays correct.
- The freshness check is racy (no server CAS) ↔ no corruption and both sides converge,
  but a same-file race is last-writer-wins; the losing edit survives only in server history.
  Same-file conflict recovery is copy-aside + pull --force + merge (diff --remote: idea.md).
  In-window cross-file foreign edits never advance the base silently (pre-resync base kept).
- Access support shells out to cloudflared ↔ one more prerequisite, but Cloudflare's own
  tool owns the browser hop, caching, and refresh; we never touch that credential.
- Live-only logs ↔ upstream stores none; `logs` is follow-mode by definition.
- Zero-binding install only ↔ binding wiring needs browser OAuth; that is the security model.
- Single-gadget projects ↔ covers the common case; multi-gadget is additive later.
- Text-only files ↔ matches upstream's Y.Text model; binary assets are an upstream feature first.
- Update notice is one run stale ↔ zero latency and no new failure mode on the hot path.
