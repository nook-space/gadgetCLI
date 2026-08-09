// The agent skill: shipped in the package as skill/SKILL.md. `gadget skill` prints it
// to stdout (redirect it wherever your agent reads); `gadget skill install` places it
// for a known agent (Claude Code) or at an explicit path.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  let dest: string;

  if (opts.path) {
    // A directory (or trailing slash) gets SKILL.md written inside it; anything else is
    // treated as the exact destination file.
    dest = opts.path.endsWith("/") || isExistingDir(opts.path)
      ? join(opts.path, "SKILL.md")
      : opts.path;
  } else {
    const name = target ?? "claude-code";
    if (name !== "claude-code") {
      throw new CliError(`unknown skill target: ${name}`, {
        hint: "known: claude-code; or pass --path <file-or-dir>",
        exitCode: EXIT.usage,
      });
    }
    dest = join(homedir(), ".claude", "skills", "gadget", "SKILL.md");
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  console.log(`installed the gadget skill to ${dest}`);
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
