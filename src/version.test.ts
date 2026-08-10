import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PACKAGE_NAME, VERSION } from "./version.js";

// Both constants are hand-maintained copies of package.json fields: a drifted version
// misreports in --version, and a drifted name makes the update check poll the wrong
// package (or a stranger's).
test("version.ts is in lockstep with package.json", () => {
  const pkgPath = join(fileURLToPath(import.meta.url), "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; name: string };
  expect(VERSION).toBe(pkg.version);
  expect(PACKAGE_NAME).toBe(pkg.name);
});
