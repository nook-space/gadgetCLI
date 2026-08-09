import { loadConfig, resolveProfile } from "../../config.js";
import { openSession } from "../../remote/session.js";
import { printJson, printKv } from "../render.js";

export type DoctorOptions = { profile?: string; json?: boolean };

export async function doctor(urlArg: string | undefined, opts: DoctorOptions): Promise<void> {
  const url = urlArg ?? resolveProfile(loadConfig(), opts.profile).profile.url;

  using session = openSession(url);
  const config = await session.rpc(session.api.getServerConfig(), "getServerConfig()");

  const signIn = [
    ...(config.passwordAuthEnabled ? ["password"] : []),
    ...config.authVendors.map((v) => v.vendorId),
  ];

  if (opts.json) {
    printJson({
      instance: session.origin,
      reachable: true,
      signIn,
      signupsEnabled: config.signupsEnabled,
      siteName: config.siteName,
    });
    return;
  }
  printKv([
    ["instance", session.origin],
    ["reachable", config.siteName ? `ok (${config.siteName})` : "ok"],
    ["sign-in", signIn.join(", ") || "none advertised"],
    ["signups", config.signupsEnabled ? "enabled" : "disabled"],
  ]);
}
