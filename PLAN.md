# gadgetCLI — MVP Plan

Status: Phase 1 done and critiqued. Phase 2 (read path) is next.
Style: docs use simplified technical english. One line per point. Docs are state, not story.

## Goal

Ship a CLI that moves gadget code between local files and a hosted Cloudflare OS instance.
A terminal agent or a human can create, pull, edit, push, and publish gadgets without a browser.
Auth stops at a URL the human opens. The CLI never holds third-party credentials.

## MVP command set

- `gadget login <url>` — sign in with password or "Continue with X". Store the token.
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

Not in the MVP: see `idea.md`.

## Working rules

- One task ≈ one commit. The tree is green (typecheck, lint, unit tests) at every commit.
- Commit bodies may be verbose: what, why, and AC evidence live there — not in the docs.
- Never mix refactor and feature in one commit. Ledger edits ride with the commit that caused them.
- Docs are state, not story: no history, no "we did X". A stale line is a bug. Update in the same commit.
- Tasks carry checkboxes. A phase section holds only open findings; resolved ones live in git history.
- Critique: one fresh Fable critic per phase, read-only. Triage: blocker / should-fix / nit / idea.
- Blockers and should-fixes are fixed (or explicitly ledgered) before the phase closes.
- A durable rejection of a finding becomes a decision-ledger line with the reason.
- Every bug becomes a regression test before it becomes a fix.
- ACs are runnable checks. A claim without a command or test behind it is not an AC.
- Secrets never enter git. `.gadget/` and the config dir are ignored from the first commit.

## Architecture

One npm package. Four internal modules. No runtime dependency on upstream code.

- `src/cli/` — commands, output, errors. No transport/capnweb mechanics; typed RPC calls only.
- `src/remote/` — capnweb session, vendored API types, auth. The only module that knows upstream.
- `src/sync/` — Y.Doc state, materializer, diff, push delta builder.
- `src/archive/` — `.gadget` codec (header + gzip + Yjs snapshot).
- `skill/SKILL.md` — teaches an agent the CLI verbs and the gadget idiom.

Runtime deps: `capnweb`, `yjs`, `hash-wasm`, `commander`. Nothing else.

## Data on disk

- `~/.config/gadget/config.json` — profiles `{name → {url, token}}`. Mode 0600.
- `gadget.json` — project manifest: profile, workspace id, gadget (workpiece) id, title.
- `.gadget/state.json` — base Y.Doc (base64 V2 update) + last synced version. Gitignored.
- Tracked files = gadget root map keys ∪ local files, minus ignore set.
- Ignore set: `gadget.json`, `.gadget/`, `.git/`, `node_modules/`, `mocks/`.

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
   If the resync shows foreign updates that landed during the push window, warn the user.

Push `--new`: create the workspace, then the gadget; both get the project title. Write ids to `gadget.json`.

Safety rules:
- Reject file names that are absolute or contain `..`.
- Text only: refuse non-UTF-8 file content (roots are Y.Text upstream). Refuse files over 1 MiB.
- Write `state.json` and the config atomically (temp file + rename).
- The freshness check is advisory. A same-file race is last-writer-wins; see the trade-off ledger.

## Phases

Each phase ends with a critique (see Working rules). Fix blockers before the next phase.

### Phase 0 — Skeleton and transport

- [x] 1. Init the package: TypeScript, ESM, vitest, oxlint, `gadget` bin.
      AC: `pnpm check` and `pnpm test` pass; `gadget --version` prints the version.
- [x] 2. Vendor a trimmed, type-only API surface in `src/remote/types.ts`:
      PublicApi, AuthenticatedApi, Overseer, GadgetClient (subsets we call), CodeUpdate,
      CodeSubscriber, WorkpieceSummary, WorkpiecesSubscriber, console-log types, ServerConfig,
      AuthVendorInfo, AiChatAuthorInfo, LoginAttempt, GadgetMetadata, blueprint types.
      AC: type-only imports; kept members follow the deviation policy in the file header
      (subsets allowed, rewrites forbidden, any→unknown only), re-diffed at each refresh.
- [x] 3. Build the session module: normalize `<url>` → `wss://…/api`, open with capnweb,
      map close and error paths, one global RPC deadline.
      AC: unit tests cover URL normalization and deadline; error mapping gives one-line causes.
- [x] 4. Codify stub lifecycle in the session module: `using`/dispose in reverse order,
      subscribers as RpcTarget classes, apply updates synchronously and in order,
      one session per command, dispose cleanly on Ctrl-C.
      AC: rules stated once in the module header; SIGINT closes the session in a live test.
- [x] 5. Build the profile store (`~/.config/gadget/config.json`, 0600, atomic writes).
      AC: unit tests cover round-trip, file mode, missing file, corrupt file.
- [x] 6. Build the CLI frame: command registry, `--profile`, `--json`, one error renderer.
      AC: unknown commands and thrown errors render as one line + one hint; exit code ≠ 0.
- [x] 7. Implement `gadget doctor` (unauthenticated: reach, sign-in modes, signups).
      AC: correct report against the local instance; one-line failure against a dead port.
- [x] 8. Smoke-test against a local `pnpm run-local` instance.
      AC: transcript in the commit body; doctor exit code 0.

Exit: `gadget doctor <url>` reports the server's sign-in modes correctly.

### Phase 1 — Auth

- [x] 1. Implement the argon2id password hash per the upstream spec.
      Hash the raw typed username — no case folding (the reference client salts with the
      typed name; the server compares hashes verbatim and lowercases only for routing).
      AC: unit test asserts salt = SERVICE_SALT + utf8(username) and a 32-byte digest.
- [x] 2. Implement `gadget login <url>` password mode, with `--create` for signup.
      AC: integration — `--create` then re-login succeeds; wrong password hints at case.
- [x] 3. Implement OAuth mode: pick a vendor, print the URL, await `attempt.wait()`.
      AC: unit test drives a stubbed LoginAttempt; no-vendor instances explain themselves.
- [x] 4. Store the token per profile. Authenticate on every session open.
      Distinguish null results (bad credentials, name taken) from thrown errors (mode disabled).
      AC: token survives a fresh process; a bad token maps to "run gadget login".
- [x] 5. Implement `gadget whoami`. Extend `doctor` with authenticated checks.
      AC: doctor prints identity and workspace count when logged in.
- [x] 6. Integration test: create account, login, whoami against the local instance.
      AC: suite green on run-local.

Exit: password mode passes integration tests. OAuth mode verified against an
in-process capnweb loopback (stub tests cannot see stub-lifetime bugs) — a bare
local instance has no OAuth vendors.

### Phase 2 — Read path

- [ ] 1. Build the state codec (`.gadget/state.json`, atomic) and manifest io (`gadget.json`).
      AC: unit round-trip; corrupt state names the file in one line; temp+rename verified.
- [ ] 2. Build the sync engine: open workspace, list workpieces, fetch code to `ready()`.
      AC: integration — fetch a seeded workspace; stored version equals the server's last.
- [ ] 3. Workpiece selection: one gadget → link it; several → error with an id+title list
      and require `--gadget`. Always take `filesRoot` from the summary; never compute it.
      AC: integration covers both paths and both root forms ("" and decimal).
- [ ] 4. Build the materializer with path-safety guards, UTF-8 checks, and the ignore set.
      AC: unit — traversal names rejected; non-UTF-8 rejected; ignore set skipped.
- [ ] 5. Implement `gadget list` (with `--json`).
      AC: integration — a created workspace appears; `--json` output parses and has ids.
- [ ] 6. Implement `gadget pull [id]` with first-pull linking and the abort-on-conflict rule.
      AC: integration — first pull links the manifest; a conflict aborts, writes nothing,
      lists the files; `--force` overwrites.
- [ ] 7. Build the diff engine. Implement `gadget status` and `gadget diff`.
      AC: unit — added/modified/deleted detected, multibyte content safe, output stable.

Exit: pull, status, and diff work against the local instance, including the conflict abort.

### Phase 3 — Write path

- [ ] 1. Build the push delta builder: fast-forward, text-compare refusal, one transaction,
      `updateV2` capture, whole-file replace, deletes.
      AC: unit — merged update applies cleanly to a base copy; a no-op push emits nothing.
- [ ] 2. Implement `gadget push [--force]` with post-push resync and the race warning.
      AC: integration — remote change → refusal with pull hint; `--force` pushes anyway.
- [ ] 3. Implement `gadget push --new`: workspace + gadget created, both titled, ids written.
      AC: integration — immediate pull after `--new` is clean and identical.
- [ ] 4. Implement `gadget new <dir>`: scaffold server.js, client.js, README.md, gadget.json.
      AC: scaffold matches the upstream idiom (DO class `Gadget`, `gadget` stub client).
- [ ] 5. Implement `gadget open` (use upstream's typed openGadget error codes).
      AC: prints the correct `/workspace/<id>` URL; missing/denied render their codes.
- [ ] 6. Integration: two clients converge; refusal on remote change; delete propagation;
      multibyte content survives the roundtrip.
      AC: suite green on run-local.

Exit: two clients edit one gadget against the local instance and converge without loss.

### Phase 4 — Blueprints

- [ ] 1. Build the archive codec. Mirror the upstream constants. Enforce the caps both ways
      (64 KiB metadata, 32 MiB content); bound allocations on untrusted input.
      AC: unit — magic/version/caps enforced; truncated and oversized archives rejected.
- [ ] 2. `pack`: synthesize BlueprintMetadata offline — title/description from `gadget.json`,
      author from the profile, version 1, timestamps now, `bindings: {}`.
      AC: unit — metadata validates against the vendored type.
- [ ] 3. Spike: verify ReadableStream transfer over capnweb from Node (upload + download).
      If it fails: keep `pack` + the gadget-backed publish lane; defer `new --from <url>`,
      archive `install`, and bare-archive publish; the upstream ask is already filed.
      AC: spike result recorded as one line in the assumption ledger.
- [ ] 4. Implement `gadget blueprint publish` (linked): `createBlueprint` / `updateBlueprint`.
      Precondition: refuse when local changes are unpushed or the base is stale.
      AC: integration — publish prints a `/blueprint/<id>` that `getBlueprint` resolves;
      a dirty tree is refused.
- [ ] 5. Implement bare-archive publish (`importBlueprint`) behind the same verb.
      AC: integration — returns a new id each time (create-only, by upstream design).
- [ ] 6. Implement `gadget install <url|id>` and `new --from` on one shared resolution path.
      AC: integration — zero-binding blueprint instantiates; binding-ful prints the web URL.
- [ ] 7. Cross-validate against upstream: CLI pack → instance import; instance download → CLI read.
      AC: file sets byte-identical both ways.

Exit: `publish` prints a working `/blueprint/<id>` URL. Roundtrip files are identical.

### Phase 5 — Agent surface and polish

- [ ] 1. Implement `gadget logs` (workspace-wide live stream; upstream stores none).
      AC: integration — a log from gadget code (woken via `connectToGadget`) appears;
      Ctrl-C exits 0.
- [ ] 2. Write `skill/SKILL.md`: verbs, project shape, gadget idioms, push etiquette.
      AC: a fresh agent completes new → push --new → edit → push using only the skill.
- [ ] 3. Align exit codes and `--json` coverage.
      AC: a documented code table (0 ok, 2 usage, 3 auth, 4 conflict, 5 rpc) matches tests.
- [ ] 4. Rewrite the README as the real quickstart (vision note until then).
      AC: quickstart commands run copy-paste clean against run-local.
- [ ] 5. Final ledger pass and end-to-end demo script.
      AC: demo green; the phase critic confirms the ledgers match the code.

Exit: an agent completes the edit loop using only the skill text.

## Test strategy

- Unit tests: archive codec, delta builder, path guards, state codec. No network.
- Integration tests: against `pnpm run-local` cloudflare-os on localhost:8787.
- Fresh identities per test run. Never assume a clean server.
- One cross-validation test per format we share with upstream.

## Assumption ledger

- The instance runs current cloudflare-os main (Aug 2026); the verified API surface holds.
- Password or gatekeeper OAuth sign-in is enabled. Access mode is out of MVP scope.
- Node ≥ 22 provides the global WebSocket; openSession preflights it with a clear error.
- Dev machine PATH node is 20: run every pnpm script with `PATH=/opt/homebrew/bin:$PATH` (24.5).
- capnweb from Node: RPC calls and callback subscriptions are proven by upstream's own tests;
  ReadableStream transfer is not — it is the Phase 4 spike, with a named fallback.
- Session tokens do not expire; one login per profile is enough.
- `.gadget` archive format v1 is stable per `docs/blueprints.md`.
- `WorkpieceSummary.filesRoot` is authoritative for root naming.
- A local test instance is available via `pnpm run-local` in `~/cloudflare-os`.
- A project links one workspace and one gadget; more gadgets need an explicit `--gadget`.
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
- Archives are create-only on the instance (`importBlueprint` mints a new id every time).
- `install` runs headless only for zero-binding blueprints, by design.
- `unpack` is not a verb; `new --from <file>` is the inverse of `pack`.
- Every RPC failure prints the cause and one next step; "no such method" suggests a CLI upgrade.
- Use upstream's typed error codes (openGadget) in the renderer; distinguish null from thrown.
- One RPC session per command; global deadline; dispose stubs in reverse order.
- Human-first output on stdout; `--json` for agents on list/status.
- The main agent writes all code; subagents only critique.

## Trade-off ledger

- Vendored types can drift ↔ zero coupling to upstream; drift surfaces as clear runtime errors.
- File token store is weaker than keychain ↔ zero native deps; 0600 limits exposure.
- Whole-file replace makes noisier CRDT history ↔ far simpler; history stays correct.
- The freshness check is racy (no server CAS) ↔ no corruption and both sides converge,
  but a same-file race is last-writer-wins; the losing edit survives only in server history.
- No Access mode in MVP ↔ avoids Origin-header and service-token complexity now.
- Live-only logs ↔ upstream stores none; `logs` is follow-mode by definition.
- Zero-binding install only ↔ binding wiring needs browser OAuth; that is the security model.
- Single-gadget projects ↔ covers the common case; multi-gadget is additive later.
- Text-only files ↔ matches upstream's Y.Text model; binary assets are an upstream feature first.
