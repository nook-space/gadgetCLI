// Composes profile + session + authenticate into the one entry point commands
// that need an authenticated instance use. Auth failures map here, once.

import { loadConfig, resolveProfile } from "../config.js";
import { CliError, EXIT } from "../errors.js";
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
  const session = openSession(profile.url);
  try {
    const authed = await authenticate(session, profile.token, name);
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
    throw new CliError(`the instance rejected the stored session token`, {
      cause: err,
      hint: `run: gadget login ${session.origin}`,
      exitCode: EXIT.auth,
    });
  }
}
