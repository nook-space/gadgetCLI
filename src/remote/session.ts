// One RPC session per command invocation, against wss://<instance>/api.
//
// Lifecycle rules (the one place they live):
// - Open late, close in a finally; `using` disposes stubs in reverse acquisition order.
// - Subscriber callbacks are RpcTarget classes; apply update() synchronously and in order.
// - Every RPC awaits under session.rpc() so a hung server cannot hang the CLI.
// - Transport failures are mapped here, once; commands only ever see CliError or domain errors.
// - SIGINT closes open sessions so the server drops subscriptions promptly.

import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import NodeWebSocket from "ws";
import { CliError, EXIT } from "../errors.js";
import type { PublicApi } from "./types.js";

export const RPC_DEADLINE_MS = 30_000;

// Instance URL → workshop origin. Bare hosts default to https; localhost defaults to http,
// which is what `pnpm run-local` serves. ws(s):// is accepted as an alias for http(s)://.
// Only origins are accepted: the workshop owns its whole URL space, so a path almost
// certainly means a paste mistake.
export function instanceOrigin(input: string): string {
  const aliased = input.replace(/^ws(s?):\/\//i, "http$1://");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(aliased)
    ? aliased
    : `${/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(aliased) ? "http" : "https"}://${aliased}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError(`invalid instance URL: ${input}`, { exitCode: EXIT.usage });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`instance URL must be http(s): ${input}`, { exitCode: EXIT.usage });
  }
  if (url.username || url.password) {
    throw new CliError(`instance URL must not contain credentials: ${input}`, {
      hint: "log in with: gadget login <url>",
      exitCode: EXIT.usage,
    });
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

// Race a promise against the global deadline. Pure; session.rpc composes it.
export function withDeadline<T>(promise: Promise<T>, what: string, ms = RPC_DEADLINE_MS): Promise<T> {
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

// Node's global WebSocket follows the browser API and cannot set request headers, so an
// Access-gated instance needs `ws`: the token rides the upgrade request as
// `cf-access-token` (Access validates it at the edge and forwards the verified identity
// to the worker), and the same-origin `Origin` satisfies the backend's cross-origin check.
// capnweb accepts any socket exposing addEventListener/send/close, which `ws` does.
function accessSocket(origin: string, token: string): WebSocket {
  return new NodeWebSocket(apiUrl(origin), {
    headers: { "cf-access-token": token },
    origin,
  }) as unknown as WebSocket;
}

export type Session = {
  api: RpcStub<PublicApi>;
  origin: string;
  rpc<T>(promise: Promise<T>, what: string, ms?: number): Promise<T>;
  // Register for transport death. Streaming commands need this: with the socket gone,
  // nothing else holds the event loop, and a silent exit 0 would look like success.
  onBroken(handler: (err: Error) => void): void;
  close(): void;
  [Symbol.dispose](): void;
};

const openSessions = new Set<Session>();
let sigintInstalled = false;
let sigintExitCode = 130;

// Streaming commands (logs) end via Ctrl-C by design; for them the interrupt is
// success, not failure. Default stays 130 for everything else.
export function setSigintExitCode(code: number): void {
  sigintExitCode = code;
}

export type SessionOptions = {
  // A Cloudflare Access JWT to present on the upgrade request. See remote/access.ts.
  accessToken?: string;
};

export function openSession(instance: string, opts: SessionOptions = {}): Session {
  if (typeof WebSocket === "undefined") {
    throw new CliError(`gadget needs Node >= 22 (found ${process.versions.node})`, {
      hint: "this Node has no global WebSocket; upgrade Node",
    });
  }

  const origin = instanceOrigin(instance);
  let api: RpcStub<PublicApi>;
  try {
    api = newWebSocketRpcSession<PublicApi>(
      opts.accessToken ? accessSocket(origin, opts.accessToken) : apiUrl(origin),
    );
  } catch (cause) {
    throw new CliError(`cannot connect to ${origin}`, { cause, exitCode: EXIT.rpc });
  }

  let broken: Error | undefined;
  const brokenHandlers: ((err: Error) => void)[] = [];
  api.onRpcBroken((err) => {
    broken = err instanceof Error ? err : new Error(String(err));
    for (const handler of brokenHandlers) handler(broken);
  });

  const session: Session = {
    api,
    origin,
    async rpc<T>(promise: Promise<T>, what: string, ms = RPC_DEADLINE_MS): Promise<T> {
      try {
        return await withDeadline(promise, what, ms);
      } catch (err) {
        if (broken !== undefined && !(err instanceof CliError)) {
          throw new CliError(`cannot reach the workshop api at ${origin}`, {
            cause: broken,
            hint: "check the URL; the instance must serve /api over WebSocket",
            exitCode: EXIT.rpc,
          });
        }
        throw err;
      }
    },
    onBroken(handler: (err: Error) => void) {
      if (broken !== undefined) handler(broken);
      else brokenHandlers.push(handler);
    },
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
      process.exit(sigintExitCode);
    });
  }
  return session;
}
