// Spawn tests: the skill ships in the package and installs where asked.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const run = promisify(execFile);
// This test sits in src/cli/commands/, so four hops reach the package root.
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");

let home: string;
beforeEach(() => (home = mkdtempSync(join(tmpdir(), "gadget-skill-"))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

function gadget(args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, [BIN, ...args], { env: { ...process.env, HOME: home, ...env } })
    .then((r) => ({ ...r, code: 0 }))
    .catch((err: Error & { code?: number; stdout: string; stderr: string }) =>
      ({ stdout: err.stdout, stderr: err.stderr, code: err.code ?? 1 }));
}

describe("gadget skill", () => {
  test("prints the SKILL.md to stdout, frontmatter and all", async () => {
    const r = await gadget(["skill"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^---\nname: gadget/);
    expect(r.stdout).toContain("Writing gadget code");
  });

  test("install (default) places it where Claude Code looks", async () => {
    const r = await gadget(["skill", "install"]);
    expect(r.code).toBe(0);
    const dest = join(home, ".claude", "skills", "gadget", "SKILL.md");
    expect(r.stdout).toContain(dest);
    expect(readFileSync(dest, "utf8")).toContain("name: gadget");
  });

  test("install claude-code is the same as the default", async () => {
    const r = await gadget(["skill", "install", "claude-code"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, ".claude", "skills", "gadget", "SKILL.md"), "utf8"))
      .toContain("name: gadget");
  });

  test("--path <dir> writes SKILL.md inside; --path <file> writes exactly there", async () => {
    const dirTarget = join(home, "rules");
    const inDir = await gadget(["skill", "install", "--path", dirTarget + "/"]);
    expect(inDir.code).toBe(0);
    expect(readFileSync(join(dirTarget, "SKILL.md"), "utf8")).toContain("name: gadget");

    const fileTarget = join(home, "AGENTS.md");
    const asFile = await gadget(["skill", "install", "--path", fileTarget]);
    expect(asFile.code).toBe(0);
    expect(readFileSync(fileTarget, "utf8")).toContain("name: gadget");
  });

  test("an unknown target is a usage error", async () => {
    const r = await gadget(["skill", "install", "cursor"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown skill target: cursor");
  });
});
