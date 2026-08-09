import { loadConfig, saveConfig } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";
import { hashPassword } from "../../remote/auth.js";
import { authenticate } from "../../remote/authed.js";
import { instanceOrigin as instanceOriginOf, openSession, type Session } from "../../remote/session.js";
import type { AuthVendorInfo, ServerConfig } from "../../remote/types.js";
import { prompt, readPassword } from "../prompt.js";

// OAuth completion is human-paced (a browser round trip), not server-paced.
const OAUTH_WAIT_MS = 10 * 60_000;

// Mirrors the server's rule ("must be alphanumeric starting with a letter") so a bad
// name fails before a 64 MiB argon2 hash is burned on it.
const USERNAME_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;

export type LoginOptions = {
  profile?: string;
  create?: boolean;
  username?: string;
  name?: string;
  vendor?: string;
};

export async function login(url: string, opts: LoginOptions): Promise<void> {
  // Discovery on a short-lived session: the socket must not sit open across
  // human-paced prompting and the slow hash, where idle timeouts could kill it.
  let config: ServerConfig;
  {
    using discovery = openSession(url);
    config = await discovery.rpc(discovery.api.getServerConfig(), "getServerConfig()");
  }

  const plan = planLogin(config, opts, new URL(instanceOriginOf(url)).origin);

  if (plan.mode === "oauth") {
    // OAuth keeps one session for the whole flow: attempt.wait() lives on it.
    using session = openSession(url);
    const token = await oauthLogin(session, config, opts.vendor);
    await finishLogin(session, token, opts.profile);
    return;
  }

  const { username, hash } = await gatherCredentials(opts);
  using session = openSession(url);
  const token = plan.create
    ? await createAccount(session, config, username, opts.name ?? username, hash)
    : await passwordLogin(session, username, hash);
  await finishLogin(session, token, opts.profile);
}

export type LoginPlan = { mode: "oauth" } | { mode: "password"; create: boolean };

// Pure dispatch: which auth path a login takes, given what the instance offers and
// what the user asked for. Throws a CliError for a request the instance can't honor
// (notably --create against an OAuth-only instance, where first sign-in IS the signup).
export function planLogin(config: ServerConfig, opts: LoginOptions, origin: string): LoginPlan {
  if (opts.vendor || !config.passwordAuthEnabled) {
    if (opts.create) {
      const how = config.authVendors.length
        ? `sign in with a provider (accounts are created automatically): ` +
          `gadget login ${origin} --vendor ${config.authVendors[0]!.vendorId}`
        : "this instance offers no password signup and no sign-in providers gadget-cli supports";
      throw new CliError("this instance does not use password accounts, so --create does nothing", {
        hint: how,
        exitCode: EXIT.usage,
      });
    }
    return { mode: "oauth" };
  }
  return { mode: "password", create: opts.create === true };
}

// Verify the token and learn who we are before storing anything.
async function finishLogin(session: Session, token: string, profileOpt?: string): Promise<void> {
  const authed = await authenticate(session, token, "(new login)");
  const me = await session.rpc(authed.whoami(), "whoami()");

  const store = loadConfig();
  const profileName = profileOpt ?? new URL(session.origin).host;
  store.profiles[profileName] = { url: session.origin, token };
  store.current = profileName;
  saveConfig(store);

  console.log(`logged in as ${me.name} (${me.id})`);
  console.log(`profile ${profileName} is now current`);
}

async function gatherCredentials(
  opts: LoginOptions,
): Promise<{ username: string; hash: Uint8Array }> {
  const username = opts.username ?? (await prompt("username: "));
  if (!username) throw new CliError("a username is required", { exitCode: EXIT.usage });
  if (!USERNAME_REGEX.test(username)) {
    throw new CliError(`invalid username: ${username}`, {
      hint: "usernames are alphanumeric and start with a letter",
      exitCode: EXIT.usage,
    });
  }
  const password = await readPassword("password: ");
  return { username, hash: await hashPassword(username, password) };
}

async function createAccount(
  session: Session,
  config: ServerConfig,
  username: string,
  displayName: string,
  hash: Uint8Array,
): Promise<string> {
  if (!config.signupsEnabled) {
    throw new CliError("signups are disabled on this instance", { exitCode: EXIT.auth });
  }
  const token = await session.rpc(
    session.api.createAccount(username, displayName, hash),
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

async function passwordLogin(
  session: Session,
  username: string,
  hash: Uint8Array,
): Promise<string> {
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
  // Disposing the attempt is upstream's "abandon the sign-in" signal, so it must
  // happen only after wait() settles — hence `return await`, never a bare return.
  using attemptStub = attempt;

  console.error(`open this URL in a browser to sign in with ${vendor.displayName}:`);
  console.error(`  ${url}`);
  console.error("(a new account is created automatically on first sign-in)");
  console.error("waiting for the sign-in to complete...");
  try {
    return await session.rpc(attemptStub.wait(), "sign-in", OAUTH_WAIT_MS);
  } catch (err) {
    if (err instanceof CliError && /timed out/.test(err.message)) {
      throw new CliError("the sign-in was not completed within 10 minutes", {
        hint: "run gadget login again",
        exitCode: EXIT.auth,
      });
    }
    // The server rejects a first-time sign-in when signups are closed; surface it
    // as the auth condition it is, not a generic RPC error.
    if (err instanceof Error && /sign-?up/i.test(err.message)) {
      throw new CliError("this instance is not accepting new sign-ups", {
        hint: "ask the instance admin for access, then sign in again",
        exitCode: EXIT.auth,
      });
    }
    throw err;
  }
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
    // Reachable only when password auth is off with no vendors — a Cloudflare Access
    // deployment (the server forces password auth on when it would otherwise lock out).
    throw new CliError("this instance offers no sign-in method gadget-cli supports", {
      hint: "it likely requires Cloudflare Access, which gadget-cli does not support yet",
      exitCode: EXIT.auth,
    });
  }
  throw new CliError("several sign-in providers; pick one", {
    hint: `pass --vendor <id>; offered: ${vendors.map((v) => v.vendorId).join(", ")}`,
    exitCode: EXIT.usage,
  });
}
