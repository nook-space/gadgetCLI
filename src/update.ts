// Update awareness: a cached, background registry check and a one-line stderr notice.
//
// Rules, in order of importance:
// - Never block or fail a command. The check runs in a detached child; the notice you
//   see comes from the PREVIOUS run's cache, so the hot path does no network I/O.
// - Never mutate anything on its own. Updating is an explicit `gadget update`.
// - Never speak to machines. Suppressed unless stdout is a TTY, and off in CI or when
//   GADGET_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER is set — agents must not parse nag text.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

const CHECK_INTERVAL_MS = 24 * 3600e3;

export function updateCachePath(): string {
  return join(configDir(), "update-check.json");
}

type UpdateCache = { checkedAt: string; latest: string | null };

function readCache(): UpdateCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(updateCachePath(), "utf8")) as UpdateCache;
    return typeof parsed?.checkedAt === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True when `latest` is a higher release than `current`. Prereleases never notify. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const parts = (core ?? "").split(".").map((n) => Number(n));
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return undefined;
    return { parts, prerelease: pre !== undefined };
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b || a.prerelease) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i]! !== b.parts[i]!) return a.parts[i]! > b.parts[i]!;
  }
  return false;
}

/** How this CLI was installed, which decides what update command to recommend. */
export type InstallMethod = "npx" | "homebrew" | "npm-global" | "source";

export function detectInstallMethod(modulePath = fileURLToPath(import.meta.url)): InstallMethod {
  const path = modulePath.split(sep).join("/");
  if (path.includes("/_npx/")) return "npx";
  if (path.includes("/Cellar/") || path.includes("/homebrew/")) return "homebrew";
  if (path.includes("/node_modules/")) return "npm-global";
  return "source";
}

/** What to tell the user to do — always actionable, whatever the install method. */
export function updateAdvice(method: InstallMethod): string {
  switch (method) {
    case "npm-global":
      return `gadget update  (runs \`npm install -g ${PACKAGE_NAME}@latest\`)`;
    case "homebrew":
      // A Homebrew formula would carry a plain name, never the scoped npm one.
      return "brew upgrade gadget-cli";
    case "npx":
      return `npx ${PACKAGE_NAME}@latest  (npx caches; @latest forces a refetch)`;
    case "source":
      return "git pull && pnpm build  (source checkout)";
  }
}

/** The command `gadget update` may run itself. Only the case we can determine safely. */
export function runnableUpdateCommand(method: InstallMethod): string | undefined {
  return method === "npm-global" ? `npm install -g ${PACKAGE_NAME}@latest` : undefined;
}

function suppressed(json?: boolean): boolean {
  return (
    json === true ||
    !process.stdout.isTTY ||
    process.env["GADGET_NO_UPDATE_CHECK"] !== undefined ||
    process.env["NO_UPDATE_NOTIFIER"] !== undefined ||
    process.env["CI"] !== undefined
  );
}

/** Kick off tomorrow's answer: a detached fetch, only when the cache is stale. */
function scheduleCheck(): void {
  const cache = readCache();
  const fresh =
    cache !== undefined && Date.now() - new Date(cache.checkedAt).getTime() < CHECK_INTERVAL_MS;
  if (fresh) return;
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const worker = join(dirname(fileURLToPath(import.meta.url)), "update-worker.js");
    const child = spawn(process.execPath, [worker, updateCachePath(), PACKAGE_NAME], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => {});
    child.unref();
  } catch {
    // A failed check must never affect the command the user actually ran.
  }
}

/**
 * Print the update notice (if any) and schedule the next check. Called once per run,
 * after the command's own output. `skillStale` names skill copies that no longer match
 * the bundled skill, so the two-step update stays discoverable.
 */
export function noticeAndSchedule(opts: { json?: boolean; skillStale?: string[] }): void {
  if (suppressed(opts.json)) return;

  const cache = readCache();
  if (cache?.latest && isNewer(cache.latest, VERSION)) {
    process.stderr.write(
      `\ngadget ${VERSION} → ${cache.latest} available. update: ` +
        `${updateAdvice(detectInstallMethod())}\n`,
    );
  }
  if (opts.skillStale && opts.skillStale.length > 0) {
    const where = opts.skillStale.length === 1 ? opts.skillStale[0]! : `${opts.skillStale.length} copies`;
    process.stderr.write(
      `\nthe installed agent skill is out of date (${where}). refresh: gadget skill refresh\n`,
    );
  }

  scheduleCheck();
}

/** Record a completed update check by hand (used by `gadget update` after it runs). */
export function stampCheck(latest: string | null): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      updateCachePath(),
      JSON.stringify({ checkedAt: new Date().toISOString(), latest }),
    );
  } catch {
    // Best effort.
  }
}
