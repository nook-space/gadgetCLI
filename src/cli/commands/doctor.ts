import { loadConfig, resolveProfile, type Config } from "../../config.js";
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
      : `${auth.state} (run: gadget login ${session.origin})`],
  ]);
}

type AuthCheck =
  | { ok: true; state: "ok"; name: string; workspaces: number }
  | { ok: false; state: "not logged in" | "token rejected" };

async function checkAuth(
  session: ReturnType<typeof openSession>,
  store: Config,
  origin: string,
  profileOpt?: string,
): Promise<AuthCheck> {
  // The profile that matches this doctor run: --profile, else any profile for this origin.
  const entry = profileOpt
    ? store.profiles[profileOpt]
    : Object.values(store.profiles).find((p) => p.url === origin);
  if (!entry?.token || entry.url !== origin) return { ok: false, state: "not logged in" };

  try {
    const authed = await authenticate(session, entry.token, "doctor");
    const [me, gadgets] = await Promise.all([
      session.rpc(authed.whoami(), "whoami()"),
      session.rpc(authed.listGadgets(), "listGadgets()"),
    ]);
    return { ok: true, state: "ok", name: me.name, workspaces: gadgets.length };
  } catch {
    return { ok: false, state: "token rejected" };
  }
}
