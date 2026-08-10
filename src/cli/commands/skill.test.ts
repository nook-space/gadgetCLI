// Spawn tests: the skill ships in the package, installs where asked, refreshes every
// recorded copy, and never nags a machine.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const run = promisify(execFile);
// This test sits in src/cli/commands/, so four hops reach the package root.
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");
const BUNDLED = join(ROOT, "skill", "SKILL.md");

let home: string;
beforeEach(() => (home = mkdtempSync(join(tmpdir(), "gadget-skill-"))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

function gadget(args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, [BIN, ...args], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...env },
  })
    .then((r) => ({ ...r, code: 0 }))
    .catch((err: Error & { code?: number; stdout: string; stderr: string }) =>
      ({ stdout: err.stdout, stderr: err.stderr, code: err.code ?? 1 }));
}

const configFile = () => join(home, ".config", "gadget", "config.json");
const recorded = () =>
  (JSON.parse(readFileSync(configFile(), "utf8")) as { skillInstalls?: string[] }).skillInstalls ?? [];

describe("gadget skill", () => {
  test("prints the SKILL.md to stdout, frontmatter and all", async () => {
    const r = await gadget(["skill"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^---\nname: gadget/);
    expect(r.stdout).toContain("Writing gadget code");
  });

  test("install (default) places it where Claude Code looks and records it", async () => {
    const r = await gadget(["skill", "install"]);
    expect(r.code).toBe(0);
    const dest = join(home, ".claude", "skills", "gadget", "SKILL.md");
    expect(r.stdout).toContain(dest);
    expect(readFileSync(dest, "utf8")).toContain("name: gadget");
    expect(recorded()).toEqual([dest]);
  });

  test("install claude-code is the same as the default", async () => {
    await gadget(["skill", "install", "claude-code"]);
    expect(readFileSync(join(home, ".claude", "skills", "gadget", "SKILL.md"), "utf8"))
      .toContain("name: gadget");
  });

  test("--path <dir> writes SKILL.md inside; --path <file> writes exactly there", async () => {
    const dirTarget = join(home, "rules");
    expect((await gadget(["skill", "install", "--path", dirTarget + "/"])).code).toBe(0);
    expect(readFileSync(join(dirTarget, "SKILL.md"), "utf8")).toContain("name: gadget");

    const fileTarget = join(home, "team-skill.md");
    expect((await gadget(["skill", "install", "--path", fileTarget])).code).toBe(0);
    expect(readFileSync(fileTarget, "utf8")).toContain("name: gadget");
    expect(recorded()).toEqual([join(dirTarget, "SKILL.md"), fileTarget]);
  });

  test("an unknown target is a usage error", async () => {
    const r = await gadget(["skill", "install", "cursor"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown skill target: cursor");
  });
});

describe("gadget skill refresh", () => {
  test("rewrites drifted copies, leaves current ones, forgets deleted ones", async () => {
    const a = join(home, "a", "SKILL.md");
    const b = join(home, "b", "SKILL.md");
    await gadget(["skill", "install", "--path", a]);
    await gadget(["skill", "install", "--path", b]);

    writeFileSync(a, "stale content from an older CLI\n"); // drifted
    rmSync(b); // user deleted it

    const r = await gadget(["skill", "refresh"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`updated ${a}`);
    expect(r.stdout).toContain(`forgot ${b}`);
    expect(readFileSync(a, "utf8")).toBe(readFileSync(BUNDLED, "utf8"));
    expect(recorded()).toEqual([a]); // the deleted one is no longer tracked
  });

  test("refresh with nothing installed says so; a second refresh is a no-op", async () => {
    const empty = await gadget(["skill", "refresh"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("not installed anywhere");

    await gadget(["skill", "install"]);
    const again = await gadget(["skill", "refresh"]);
    expect(again.stdout).toContain("already up to date");
  });
});

describe("update notice", () => {
  test("never nags a machine, even with an update cached", async () => {
    // A cache claiming a much newer version. stdout is a pipe here (as for any agent),
    // so the notice must stay silent.
    mkdirSync(join(home, ".config", "gadget"), { recursive: true });
    writeFileSync(
      join(home, ".config", "gadget", "update-check.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), latest: "99.0.0" }),
    );
    const r = await gadget(["skill"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).not.toContain("99.0.0");
  });

  test("stale installed skills do not nag a machine either", async () => {
    await gadget(["skill", "install"]);
    writeFileSync(join(home, ".claude", "skills", "gadget", "SKILL.md"), "old\n");
    const r = await gadget(["skill"]);
    expect(r.stderr).toBe("");
  });
});
