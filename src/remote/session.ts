// One RPC session per command invocation, against wss://<instance>/api.
//
// Lifecycle rules (the one place they live):
// - Open late, close in a finally; `using` disposes stubs in reverse acquisition order.
// - Subscriber callbacks are RpcTarget classes; apply update() synchronously and in order.
// - Every RPC awaits under rpc() so a hung server cannot hang the CLI.
// - SIGINT closes open sessions so the server drops subscriptions promptly.

import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import { CliError, EXIT } from "../errors.js";
import type { PublicApi } from "./types.js";

export const RPC_DEADLINE_MS = 30_000;

// Instance URL → workshop origin. Bare hosts default to https; localhost defaults to http,
// which is what `pnpm run-local` serves. Only origins are accepted: the workshop owns its
// whole URL space, so a path almost certainly means a paste mistake.
export function instanceOrigin(input: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `${/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(input) ? "http" : "https"}://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError(`invalid instance URL: ${input}`, { exitCode: EXIT.usage });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`instance URL must be http(s): ${input}`, { exitCode: EXIT.usage });
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new CliError(`instance URL must be an origin, without a path: ${input}`, {
      hint: `try: ${url.origin}`,
      exitCode: EXIT.usage,
    });
  }
  return url.origin;
}

export function apiUrl(origin: string): string {
  return origin.replace(/^http/, "ws") + "/api";
}

// Await an RPC under the global deadline. `what` names the call in the timeout message.
export function rpc<T>(promise: Promise<T>, what: string, ms = RPC_DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CliError(`${what} timed out after ${ms / 1000}s`, {
            hint: "check the instance URL and that the server is up",
            exitCode: EXIT.rpc,
          }),
        ),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export type Session = {
  api: RpcStub<PublicApi>;
  origin: string;
  close(): void;
  [Symbol.dispose](): void;
};

const openSessions = new Set<Session>();
let sigintInstalled = false;

export function openSession(instance: string): Session {
  const origin = instanceOrigin(instance);
  let api: RpcStub<PublicApi>;
  try {
    api = newWebSocketRpcSession<PublicApi>(apiUrl(origin));
  } catch (cause) {
    throw new CliError(`cannot connect to ${origin}`, { cause, exitCode: EXIT.rpc });
  }

  const session: Session = {
    api,
    origin,
    close() {
      openSessions.delete(session);
      try {
        api[Symbol.dispose]();
      } catch {
        // Already broken; closing is best-effort.
      }
    },
    [Symbol.dispose]() {
      session.close();
    },
  };

  openSessions.add(session);
  if (!sigintInstalled) {
    sigintInstalled = true;
    process.on("SIGINT", () => {
      for (const s of openSessions) s.close();
      process.exit(130);
    });
  }
  return session;
}
