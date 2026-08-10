import { loadConfig, resolveProfile, type Config } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";
import {
  accessToken, cloudflaredInstalled, cloudflaredInstallHint, isAccessProtected,
} from "../../remote/access.js";
import { authenticate, tryAuthenticateViaAccess } from "../../remote/authed.js";
import { instanceOrigin, openSession } from "../../remote/session.js";
import { VERSION } from "../../version.js";
import { printJson, printKv } from "../render.js";

export type DoctorOptions = { profile?: string; json?: boolean };

export async function doctor(urlArg: string | undefined, opts: DoctorOptions): Promise<void> {
  const store = loadConfig();
  const url = urlArg ?? resolveProfile(store, opts.profile).profile.url;
  const origin = instanceOrigin(url);

  // Access first: an Access-gated instance is unreachable without a token, so a
  // diagnosis has to establish that before blaming the network.
  const gated = await isAccessProtected(origin);
  const token = gated ? accessToken(origin) : undefined;
  const access = describeAccess(gated, token !== undefined, origin);
  if (gated && !token) {
    // Nothing else can be checked from here; report the blocker and how to clear it.
    return report(opts, { origin, access, node: process.versions.node });
  }

  using session = openSession(origin, { accessToken: token });
  const config = await session.rpc(session.api.getServerConfig(), "getServerConfig()");
  const signIn = [
    ...(config.passwordAuthEnabled ? ["password"] : []),
    ...config.authVendors.map((v) => v.vendorId),
    ...(gated ? ["cloudflare access"] : []),
  ];
  const auth = await checkAuth(session, store, origin, opts.profile, token !== undefined);

  report(opts, {
    origin,
    access,
    node: process.versions.node,
    reachable: config.siteName ? `ok (${config.siteName})` : "ok",
    signIn: signIn.join(", ") || "none advertised",
    signups: config.signupsEnabled ? "enabled" : "disabled",
    auth,
    raw: { signIn, signupsEnabled: config.signupsEnabled, siteName: config.siteName },
  });
}

type Report = {
  origin: string;
  access: string;
  node: string;
  reachable?: string;
  signIn?: string;
  signups?: string;
  auth?: AuthCheck;
  raw?: { signIn: string[]; signupsEnabled: boolean; siteName: string };
};

function report(opts: DoctorOptions, r: Report): void {
  if (opts.json) {
    printJson({
      instance: r.origin,
      reachable: r.reachable !== undefined,
      access: r.access,
      signIn: r.raw?.signIn ?? [],
      signupsEnabled: r.raw?.signupsEnabled ?? null,
      siteName: r.raw?.siteName ?? null,
      auth: r.auth ?? null,
      cli: { version: VERSION, node: r.node },
    });
    return;
  }
  const rows: [string, string][] = [
    ["gadget", `${VERSION} (node ${r.node})`],
    ["instance", r.origin],
    ["access", r.access],
  ];
  if (r.reachable !== undefined) {
    rows.push(
      ["reachable", r.reachable],
      ["sign-in", r.signIn!],
      ["signups", r.signups!],
      ["auth", describeAuth(r.auth!, r.origin)],
    );
  }
  printKv(rows);
}

function describeAccess(gated: boolean, hasToken: boolean, origin: string): string {
  if (!gated) return "not in use";
  if (!cloudflaredInstalled()) {
    return `required — cloudflared is not installed; ${cloudflaredInstallHint()}`;
  }
  return hasToken
    ? "required — session ok"
    : `required — no session (run: cloudflared access login ${origin})`;
}

function describeAuth(auth: AuthCheck, origin: string): string {
  if (auth.ok) {
    return `ok — ${auth.name} (${auth.workspaces} workspace${auth.workspaces === 1 ? "" : "s"})`;
  }
  return auth.state === "check failed"
    ? `check failed: ${auth.detail}`
    : `${auth.state} (run: gadget login ${origin})`;
}

type AuthCheck =
  | { ok: true; state: "ok"; name: string; workspaces: number }
  | { ok: false; state: "not logged in" | "token rejected" }
  | { ok: false; state: "check failed"; detail: string };

async function checkAuth(
  session: ReturnType<typeof openSession>,
  store: Config,
  origin: string,
  profileOpt: string | undefined,
  hasAccessToken: boolean,
): Promise<AuthCheck> {
  const entry = profileOpt
    ? resolveProfile(store, profileOpt).profile
    : Object.values(store.profiles).find((p) => p.url === origin);

  try {
    if (entry?.token) {
      const authed = await authenticate(session, entry.token, "doctor");
      return summarize(session, authed);
    }
    // No stored token: an Access-gated instance may still identify us from the
    // connection itself, which is exactly what an Access profile relies on.
    if (hasAccessToken) {
      const authed = await tryAuthenticateViaAccess(session);
      if (authed) return summarize(session, authed);
    }
    return { ok: false, state: "not logged in" };
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT.auth) {
      return { ok: false, state: "token rejected" };
    }
    return {
      ok: false,
      state: "check failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function summarize(
  session: ReturnType<typeof openSession>,
  authed: { whoami(): Promise<{ name: string }>; listGadgets(): Promise<unknown[]> },
): Promise<AuthCheck> {
  const [me, gadgets] = await Promise.all([
    session.rpc(authed.whoami(), "whoami()"),
    session.rpc(authed.listGadgets(), "listGadgets()"),
  ]);
  return { ok: true, state: "ok", name: me.name, workspaces: gadgets.length };
}
