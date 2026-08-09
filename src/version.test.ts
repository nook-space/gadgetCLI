import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";
import { VERSION } from "./version.js";

test("version.ts is in lockstep with package.json", () => {
  const pkgPath = join(fileURLToPath(import.meta.url), "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
