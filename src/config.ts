// Profile store: ~/.config/gadget/config.json (XDG_CONFIG_HOME respected).
// Holds instance URLs and session tokens — dir 0700, file 0600, atomic writes.

import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT } from "./errors.js";

export type Profile = { url: string; token?: string };
export type Config = { current?: string; profiles: Record<string, Profile> };

export function configPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "gadget", "config.json");
}

export function loadConfig(): Config {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { profiles: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Config;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.profiles !== "object") {
      throw new Error("bad shape");
    }
    return parsed;
  } catch {
    throw new CliError(`config file is not valid JSON: ${path}`, {
      hint: "fix or delete it, then run: gadget login <url>",
    });
  }
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600); // writeFileSync mode is ignored when the tmp file already exists
  renameSync(tmp, path);
}

// Resolve which profile a command runs against: --profile, else the current one,
// else the sole profile, else fail with the next step.
export function resolveProfile(config: Config, name?: string): { name: string; profile: Profile } {
  const pick = (n: string) => {
    const profile = config.profiles[n];
    if (!profile) {
      throw new CliError(`no such profile: ${n}`, {
        hint: `known: ${Object.keys(config.profiles).join(", ") || "none"}`,
        exitCode: EXIT.usage,
      });
    }
    return { name: n, profile };
  };
  if (name) return pick(name);
  if (config.current) return pick(config.current);
  const names = Object.keys(config.profiles);
  if (names.length === 1) return pick(names[0]!);
  throw new CliError(names.length === 0 ? "not logged in" : "several profiles; pick one", {
    hint: names.length === 0 ? "run: gadget login <url>" : "pass --profile <name>",
    exitCode: EXIT.auth,
  });
}
