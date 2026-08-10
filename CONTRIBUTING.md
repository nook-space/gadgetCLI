# Contributing

Thanks for looking. This is a small, independent project — issues and pull requests are
welcome.

## Getting set up

```sh
pnpm install
pnpm check        # typecheck + lint
pnpm test         # unit + spawn tests (no instance needed)
```

The integration tests skip themselves unless you point them at a running Cloudflare OS:

```sh
git clone https://github.com/cloudflare/cloudflare-os && cd cloudflare-os
corepack pnpm run-local                       # serves http://localhost:8787
GADGET_TEST_URL=http://localhost:8787 pnpm test
```

## What a good change looks like

- `DESIGN.md` records why things are shaped as they are. If your change contradicts a
  decision or trade-off there, update that line in the same commit — a stale line is a bug.
- Every bug fix comes with a test that fails without it. The suite is the argument that
  the sync path is safe; please keep it that way.
- Keep the pure core (`src/sync/`, `src/archive/`) free of I/O, and keep transport
  details inside `src/remote/`.
- Comments explain constraints the code cannot show, not what the next line does.

## Scope

The CLI is a pure client of a Cloudflare OS instance's own API. It moves code; it does not
grant authority — anything that creates a capability (OAuth, connections) ends at a URL a
human opens. Changes that blur that line are unlikely to land.

`idea.md` is the roadmap if you're looking for something to pick up.
