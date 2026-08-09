// Profile store: ~/.config/gadget/config.json (XDG_CONFIG_HOME respected).
// Holds instance URLs and session tokens — dir 0700, file 0600, atomic writes.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT } from "./errors.js";

export type Profile = { url: string; token?: string };
export type Config = { current?: string; profiles: Record<string, Profile> };

export function configPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "gadget", "config.json");
}

function isProfile(value: unknown): value is Profile {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as Profile).url === "string" &&
    ["string", "undefined"].includes(typeof (value as Profile).token)
  );
}

export function loadConfig(): Config {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw new CliError(`cannot read config file: ${path}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`config file is not valid JSON: ${path}`, {
      hint: "fix or delete it, then run: gadget login <url>",
    });
  }

  const config = parsed as Config;
  const shapeOk =
    typeof config === "object" && config !== null && !Array.isArray(config) &&
    typeof config.profiles === "object" && config.profiles !== null &&
    !Array.isArray(config.profiles) &&
    Object.values(config.profiles).every(isProfile) &&
    ["string", "undefined"].includes(typeof config.current);
  if (!shapeOk) {
    throw new CliError(`config file has an unexpected shape: ${path}`, {
      hint: "fix or delete it, then run: gadget login <url>",
    });
  }
  return config;
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Unique tmp name: concurrent invocations must not interleave on one tmp path.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
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
  if (names.length === 0) {
    throw new CliError("not logged in", { hint: "run: gadget login <url>", exitCode: EXIT.auth });
  }
  throw new CliError("several profiles; pick one", {
    hint: "pass --profile <name>",
    exitCode: EXIT.usage,
  });
}
