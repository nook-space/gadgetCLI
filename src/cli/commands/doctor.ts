import { loadConfig, resolveProfile, type Config } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";
import { authenticate } from "../../remote/authed.js";
import { openSession } from "../../remote/session.js";
import { printJson, printKv } from "../render.js";

export type DoctorOptions = { profile?: string; json?: boolean };

export async function doctor(urlArg: string | undefined, opts: DoctorOptions): Promise<void> {
  const store = loadConfig();
  const url = urlArg ?? resolveProfile(store, opts.profile).profile.url;

  using session = openSession(url);
  const config = await session.rpc(session.api.getServerConfig(), "getServerConfig()");

  const signIn = [
    ...(config.passwordAuthEnabled ? ["password"] : []),
    ...config.authVendors.map((v) => v.vendorId),
  ];

  const auth = await checkAuth(session, store, session.origin, opts.profile);

  if (opts.json) {
    printJson({
      instance: session.origin,
      reachable: true,
      signIn,
      signupsEnabled: config.signupsEnabled,
      siteName: config.siteName,
      auth,
    });
    return;
  }
  printKv([
    ["instance", session.origin],
    ["reachable", config.siteName ? `ok (${config.siteName})` : "ok"],
    ["sign-in", signIn.join(", ") || "none advertised"],
    ["signups", config.signupsEnabled ? "enabled" : "disabled"],
    ["auth", auth.ok
      ? `ok — ${auth.name} (${auth.workspaces} workspace${auth.workspaces === 1 ? "" : "s"})`
      : auth.state === "check failed"
        ? `check failed: ${auth.detail}`
        : `${auth.state} (run: gadget login ${session.origin})`],
  ]);
}

type AuthCheck =
  | { ok: true; state: "ok"; name: string; workspaces: number }
  | { ok: false; state: "not logged in" | "token rejected" }
  | { ok: false; state: "check failed"; detail: string };

async function checkAuth(
  session: ReturnType<typeof openSession>,
  store: Config,
  origin: string,
  profileOpt?: string,
): Promise<AuthCheck> {
  // The profile that matches this doctor run: --profile (validated), else any profile
  // for this origin.
  const entry = profileOpt
    ? resolveProfile(store, profileOpt).profile
    : Object.values(store.profiles).find((p) => p.url === origin);
  if (!entry?.token || entry.url !== origin) return { ok: false, state: "not logged in" };

  try {
    const authed = await authenticate(session, entry.token, "doctor");
    const [me, gadgets] = await Promise.all([
      session.rpc(authed.whoami(), "whoami()"),
      session.rpc(authed.listGadgets(), "listGadgets()"),
    ]);
    return { ok: true, state: "ok", name: me.name, workspaces: gadgets.length };
  } catch (err) {
    // Only a genuine auth rejection prescribes re-login; anything else (timeout,
    // server bug) is reported as what it is — a wrong prescription is worse than none.
    if (err instanceof CliError && err.exitCode === EXIT.auth) {
      return { ok: false, state: "token rejected" };
    }
    return { ok: false, state: "check failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
