// Cloudflare Access support.
//
// Access guards the whole hostname, so without a valid Access JWT the CLI cannot even
// reach /api. We deliberately do NOT implement the Access login ourselves: `cloudflared`
// is Cloudflare's own tool for it, it caches and silently refreshes the session, and
// delegating keeps the browser hop — and the credential — out of this CLI entirely.
//
// The token is fetched fresh per command. Nothing Access-related is ever written to our
// config: an Access profile stores a URL and a flag, no bearer secret at all.

import { spawnSync } from "node:child_process";
import { CliError, EXIT } from "../errors.js";

// cloudflared exits 0 even when it has no session, printing an explanation instead — so
// the SHAPE of stdout is the only reliable signal that we got a token.
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Whether Cloudflare Access guards this instance's API. */
export async function isAccessProtected(origin: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api", origin), {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return isAccessChallenge(
      response.headers.get("location") ?? "",
      response.headers.get("www-authenticate") ?? "",
    );
  } catch {
    // Unreachable, or not speaking HTTP: let the ordinary connect path report the real
    // failure rather than mislabeling it an Access problem.
    return false;
  }
}

/** Access answers an unauthenticated request with a redirect to the team's login. */
export function isAccessChallenge(location: string, wwwAuthenticate: string): boolean {
  return /cloudflareaccess\.com/i.test(location) || /cloudflare-access/i.test(wwwAuthenticate);
}

/** How to get cloudflared on this platform. brew is only the answer on a Mac. */
export function cloudflaredInstallHint(platform = process.platform): string {
  return platform === "darwin"
    ? "install it: brew install cloudflared"
    : "install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
}

export function cloudflaredInstalled(): boolean {
  try {
    return spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** The cached Access JWT for `origin`, or undefined when there is no live session. */
export function accessToken(origin: string): string | undefined {
  try {
    const result = spawnSync("cloudflared", ["access", "token", `--app=${origin}`], {
      encoding: "utf8",
    });
    const out = (result.stdout ?? "").trim();
    return JWT.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A usable Access token, or a CliError naming the next step. `interactive` runs
 * cloudflared's own browser sign-in (login only); other commands must not spring a
 * browser open, so they get told what to run.
 */
export function requireAccessToken(origin: string, interactive = false): string {
  if (!cloudflaredInstalled()) {
    throw new CliError("this instance is behind Cloudflare Access, which needs cloudflared", {
      hint: cloudflaredInstallHint(),
      exitCode: EXIT.auth,
    });
  }

  const existing = accessToken(origin);
  if (existing) return existing;

  if (!interactive) {
    throw new CliError(`no Cloudflare Access session for ${hostOf(origin)}`, {
      hint: `run: cloudflared access login ${origin}`,
      exitCode: EXIT.auth,
    });
  }

  console.error(`signing in to Cloudflare Access for ${hostOf(origin)}...`);
  const result = spawnSync("cloudflared", ["access", "login", origin], { stdio: "inherit" });
  if (result.error) {
    throw new CliError("could not run cloudflared", {
      cause: result.error,
      hint: `run it yourself: cloudflared access login ${origin}`,
      exitCode: EXIT.auth,
    });
  }
  const token = accessToken(origin);
  if (!token) {
    throw new CliError("the Cloudflare Access sign-in did not produce a session", {
      hint: `run: cloudflared access login ${origin}`,
      exitCode: EXIT.auth,
    });
  }
  return token;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
