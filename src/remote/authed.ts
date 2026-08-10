// Composes profile + session + authentication into the one entry point commands that
// need an authenticated instance use. Auth failures map here, once.
//
// Two identity paths, chosen by what the profile holds:
//   token   → PublicApi.authenticate(token)         (password / OAuth sign-in)
//   access  → PublicApi.authenticateFromCfAccess()  (Cloudflare Access is the identity)
// A profile may carry both: Access as the network gate in front of a normal login.

import { loadConfig, resolveProfile } from "../config.js";
import { CliError, EXIT } from "../errors.js";
import { requireAccessToken } from "./access.js";
import { openSession, type Session } from "./session.js";
import type { AuthenticatedApi } from "./types.js";
import type { RpcStub } from "capnweb";

export type AuthedContext = {
  session: Session;
  authed: RpcStub<AuthenticatedApi>;
  profileName: string;
  origin: string;
  [Symbol.dispose](): void;
};

export async function openAuthed(profileOpt?: string): Promise<AuthedContext> {
  const { name, profile } = resolveProfile(loadConfig(), profileOpt);
  // Non-interactive: a command in the middle of a task must never spring a browser open.
  const accessToken = profile.access ? requireAccessToken(profile.url) : undefined;
  const session = openSession(profile.url, { accessToken });
  try {
    const authed = profile.token
      ? await authenticate(session, profile.token, name)
      : await authenticateViaAccess(session, profile.access === true);
    return {
      session,
      authed,
      profileName: name,
      origin: session.origin,
      [Symbol.dispose]() {
        session.close();
      },
    };
  } catch (err) {
    session.close();
    throw err;
  }
}

export async function authenticate(
  session: Session,
  token: string | undefined,
  profileName: string,
): Promise<RpcStub<AuthenticatedApi>> {
  if (!token) {
    throw new CliError(`profile ${profileName} has no session token`, {
      hint: `run: gadget login ${session.origin}`,
      exitCode: EXIT.auth,
    });
  }
  try {
    return (await session.rpc(
      session.api.authenticate(token),
      "authenticate()",
    )) as unknown as RpcStub<AuthenticatedApi>;
  } catch (err) {
    if (err instanceof CliError) throw err; // transport, already mapped
    throw new CliError(`the instance rejected the session token`, {
      cause: err,
      hint: `run: gadget login ${session.origin}`,
      exitCode: EXIT.auth,
    });
  }
}

/**
 * Authenticate from the connection's Cloudflare Access identity. Returns undefined
 * instead of throwing when `optional` is set and the deployment does not use Access as
 * its identity (Access is only the network gate) — the caller then falls back to a
 * normal login over the same, already-open socket.
 */
export async function tryAuthenticateViaAccess(
  session: Session,
): Promise<RpcStub<AuthenticatedApi> | undefined> {
  try {
    return (await session.rpc(
      session.api.authenticateFromCfAccess(),
      "authenticateFromCfAccess()",
    )) as unknown as RpcStub<AuthenticatedApi>;
  } catch (err) {
    if (err instanceof CliError) throw err; // transport
    // The backend says this exactly when CF_ACCESS_AUD is unset — Access guards the
    // hostname but the app authenticates its own way.
    if (err instanceof Error && /not authenticated with access/i.test(err.message)) {
      return undefined;
    }
    throw err;
  }
}

async function authenticateViaAccess(
  session: Session,
  isAccessProfile: boolean,
): Promise<RpcStub<AuthenticatedApi>> {
  if (!isAccessProfile) {
    throw new CliError("this profile has no session token", {
      hint: `run: gadget login ${session.origin}`,
      exitCode: EXIT.auth,
    });
  }
  const authed = await tryAuthenticateViaAccess(session);
  if (!authed) {
    throw new CliError("the instance no longer accepts the Cloudflare Access identity", {
      hint: `run: gadget login ${session.origin}`,
      exitCode: EXIT.auth,
    });
  }
  return authed;
}
