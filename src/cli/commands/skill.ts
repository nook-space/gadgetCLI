// The agent skill: shipped in the package as skill/SKILL.md. `gadget skill` prints it
// to stdout; `gadget skill install` places it for a known agent (Claude Code) or at an
// explicit path; `gadget skill refresh` re-copies it everywhere it was installed.
//
// Installs are recorded in the config so an updated CLI can refresh every copy — a
// copy is a snapshot, and a stale skill teaches an agent the wrong commands.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";

// dist/cli/commands/skill.js → package root → skill/SKILL.md (shipped via package.json "files").
function skillPath(): string {
  return join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "skill", "SKILL.md");
}

function skillText(): string {
  try {
    return readFileSync(skillPath(), "utf8");
  } catch (cause) {
    throw new CliError("could not read the bundled skill", {
      cause,
      hint: "reinstall gadget-cli; the skill ships with the package",
    });
  }
}

export function printSkill(): void {
  process.stdout.write(skillText());
}

export type SkillInstallOptions = { path?: string };

export function installSkill(target: string | undefined, opts: SkillInstallOptions): void {
  const text = skillText();
  const dest = resolveDestination(target, opts);

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  rememberInstall(dest);
  console.log(`installed the gadget skill to ${dest}`);
}

function resolveDestination(target: string | undefined, opts: SkillInstallOptions): string {
  if (opts.path) {
    // A directory (or a trailing slash) gets SKILL.md written inside it; anything else
    // is the exact destination file.
    const path = resolve(opts.path);
    return opts.path.endsWith("/") || isExistingDir(path) ? join(path, "SKILL.md") : path;
  }
  const name = target ?? "claude-code";
  if (name !== "claude-code") {
    throw new CliError(`unknown skill target: ${name}`, {
      hint: "known: claude-code; or pass --path <file-or-dir>",
      exitCode: EXIT.usage,
    });
  }
  return join(homedir(), ".claude", "skills", "gadget", "SKILL.md");
}

// Re-copy the bundled skill to every recorded install. Paths that no longer exist are
// forgotten (the user deleted or moved them); everything else is brought up to date.
export function refreshSkills(): void {
  const config = loadConfig();
  const recorded = config.skillInstalls ?? [];
  if (recorded.length === 0) {
    console.log("the skill is not installed anywhere yet (run: gadget skill install)");
    return;
  }

  const text = skillText();
  const updated: string[] = [];
  const current: string[] = [];
  const forgotten: string[] = [];

  for (const path of recorded) {
    let existing: string;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      forgotten.push(path);
      continue;
    }
    if (existing === text) {
      current.push(path);
      continue;
    }
    try {
      writeFileSync(path, text);
      updated.push(path);
    } catch (cause) {
      throw new CliError(`cannot write the skill to ${path}`, { cause });
    }
  }

  config.skillInstalls = recorded.filter((path) => !forgotten.includes(path));
  saveConfig(config);

  for (const path of updated) console.log(`updated ${path}`);
  for (const path of forgotten) console.log(`forgot ${path} (no longer there)`);
  if (updated.length === 0 && forgotten.length === 0) {
    console.log(`already up to date (${current.length} install${current.length === 1 ? "" : "s"})`);
  }
}

// Recorded installs whose content no longer matches the bundled skill. Missing files
// are not stale — they are gone, and refresh will forget them.
export function staleSkillInstalls(): string[] {
  try {
    const recorded = loadConfig().skillInstalls ?? [];
    if (recorded.length === 0) return [];
    const text = skillText();
    return recorded.filter((path) => {
      try {
        return readFileSync(path, "utf8") !== text;
      } catch {
        return false;
      }
    });
  } catch {
    return []; // a broken config must never break the command that just ran
  }
}

function rememberInstall(dest: string): void {
  try {
    const config = loadConfig();
    const recorded = config.skillInstalls ?? [];
    if (!recorded.includes(dest)) {
      config.skillInstalls = [...recorded, dest];
      saveConfig(config);
    }
  } catch {
    // Recording is a convenience for `refresh`; never fail an install over it.
  }
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
