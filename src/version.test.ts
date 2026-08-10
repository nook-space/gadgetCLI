import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PACKAGE_NAME, VERSION } from "./version.js";

type Manifest = {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  publishConfig?: Record<string, unknown>;
};

const root = join(fileURLToPath(import.meta.url), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;

// Both constants are hand-maintained copies of package.json fields: a drifted version
// misreports in --version, and a drifted name makes the update check poll the wrong
// package (or a stranger's).
test("version.ts is in lockstep with package.json", () => {
  expect(VERSION).toBe(pkg.version);
  expect(PACKAGE_NAME).toBe(pkg.name);
});

// publishConfig.provenance made every local publish fail: provenance needs an OIDC
// provider to attest the build, and a laptop has none. release.yml passes --provenance
// on the command line instead, so CI releases keep the attestation. Re-adding it here
// would break publishing from anywhere but CI — silently, until someone tried.
test("publishConfig is public and does not demand provenance", () => {
  expect(pkg.publishConfig?.["access"]).toBe("public");
  expect(pkg.publishConfig).not.toHaveProperty("provenance");
});

// The package is dist plus the skill: the bin must exist after a build, and the skill
// must ship or `gadget skill` has nothing to print on a real install.
test("what the package ships actually exists", () => {
  expect(pkg.files).toContain("dist");
  expect(pkg.files).toContain("skill");
  expect(existsSync(join(root, pkg.bin["gadget"]!)), pkg.bin["gadget"]).toBe(true);
  expect(existsSync(join(root, "skill", "SKILL.md"))).toBe(true);
});
