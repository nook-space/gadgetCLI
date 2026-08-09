import { loadConfig, saveConfig } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";
import { hashPassword } from "../../remote/auth.js";
import { authenticate } from "../../remote/authed.js";
import { openSession, type Session } from "../../remote/session.js";
import type { AuthVendorInfo, ServerConfig } from "../../remote/types.js";
import { prompt, readPassword } from "../prompt.js";

// OAuth completion is human-paced (a browser round trip), not server-paced.
const OAUTH_WAIT_MS = 10 * 60_000;

export type LoginOptions = {
  profile?: string;
  create?: boolean;
  username?: string;
  name?: string;
  vendor?: string;
};

export async function login(url: string, opts: LoginOptions): Promise<void> {
  using session = openSession(url);
  const config = await session.rpc(session.api.getServerConfig(), "getServerConfig()");

  const token = opts.vendor || !config.passwordAuthEnabled
    ? await oauthLogin(session, config, opts.vendor)
    : await passwordLogin(session, config, opts);

  // Verify the token and learn who we are before storing anything.
  const authed = await authenticate(session, token, "(new login)");
  const me = await session.rpc(authed.whoami(), "whoami()");

  const store = loadConfig();
  const profileName = opts.profile ?? new URL(session.origin).host;
  store.profiles[profileName] = { url: session.origin, token };
  store.current = profileName;
  saveConfig(store);

  console.log(`logged in as ${me.name} (${me.id})`);
  console.log(`profile ${profileName} is now current`);
}

async function passwordLogin(
  session: Session,
  config: ServerConfig,
  opts: LoginOptions,
): Promise<string> {
  const username = opts.username ?? (await prompt("username: "));
  if (!username) throw new CliError("a username is required", { exitCode: EXIT.usage });
  const password = await readPassword("password: ");
  const hash = await hashPassword(username, password);

  if (opts.create) {
    if (!config.signupsEnabled) {
      throw new CliError("signups are disabled on this instance", { exitCode: EXIT.auth });
    }
    const token = await session.rpc(
      session.api.createAccount(username, opts.name ?? username, hash),
      "createAccount()",
    );
    if (token === null) {
      throw new CliError(`username already taken: ${username}`, {
        hint: "log in instead (drop --create), or pick another name",
        exitCode: EXIT.auth,
      });
    }
    return token;
  }

  const token = await session.rpc(session.api.login(username, hash), "login()");
  if (token === null) {
    throw new CliError("wrong username or password", {
      hint: "the username is case-sensitive — it must match how it was typed at signup",
      exitCode: EXIT.auth,
    });
  }
  return token;
}

export async function oauthLogin(
  session: Pick<Session, "api" | "rpc">,
  config: Pick<ServerConfig, "authVendors">,
  vendorId: string | undefined,
): Promise<string> {
  const vendor = pickVendor(config.authVendors, vendorId);
  const { url, attempt } = await session.rpc(
    session.api.startGatekeeperLogin(vendor.vendorId),
    "startGatekeeperLogin()",
  );
  using attemptStub = attempt;

  console.error(`open this URL in a browser to sign in with ${vendor.displayName}:`);
  console.error(`  ${url}`);
  console.error("waiting for the sign-in to complete...");
  return session.rpc(attemptStub.wait(), "sign-in", OAUTH_WAIT_MS);
}

export function pickVendor(vendors: AuthVendorInfo[], vendorId?: string): AuthVendorInfo {
  if (vendorId) {
    const found = vendors.find((v) => v.vendorId === vendorId);
    if (!found) {
      throw new CliError(`this instance does not offer sign-in via "${vendorId}"`, {
        hint: vendors.length
          ? `offered: ${vendors.map((v) => v.vendorId).join(", ")}`
          : "this instance offers password sign-in only",
        exitCode: EXIT.usage,
      });
    }
    return found;
  }
  if (vendors.length === 1) return vendors[0]!;
  if (vendors.length === 0) {
    throw new CliError("this instance offers no OAuth sign-in", {
      hint: "use password sign-in (drop --vendor)",
      exitCode: EXIT.usage,
    });
  }
  throw new CliError("several sign-in providers; pick one", {
    hint: `pass --vendor <id>; offered: ${vendors.map((v) => v.vendorId).join(", ")}`,
    exitCode: EXIT.usage,
  });
}
