import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { configPath } from "../../config.js";
import { CliError } from "../../errors.js";
import { logout } from "./logout.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gadget-logout-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(config: unknown) {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config));
}
function readConfig() {
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

describe("logout", () => {
  test("clears the current profile and repoints current to a sole survivor", () => {
    writeConfig({
      current: "a",
      profiles: { a: { url: "https://a", token: "ta" }, b: { url: "https://b", token: "tb" } },
    });
    logout({});
    const after = readConfig();
    expect(after.profiles).toEqual({ b: { url: "https://b", token: "tb" } });
    expect(after.current).toBe("b");
  });

  test("--profile logs out a named instance", () => {
    writeConfig({ current: "a", profiles: { a: { url: "https://a", token: "ta" }, b: { url: "https://b", token: "tb" } } });
    logout({ profile: "b" });
    const after = readConfig();
    expect(Object.keys(after.profiles)).toEqual(["a"]);
    expect(after.current).toBe("a"); // untouched: we removed a non-current profile
  });

  test("--all clears everything", () => {
    writeConfig({ current: "a", profiles: { a: { url: "https://a", token: "ta" }, b: { url: "https://b", token: "tb" } } });
    logout({ all: true });
    const after = readConfig();
    expect(after.profiles).toEqual({});
    expect(after.current).toBeUndefined();
  });

  test("several profiles with no current and no flag asks which", () => {
    writeConfig({ profiles: { a: { url: "https://a", token: "ta" }, b: { url: "https://b", token: "tb" } } });
    expect(() => logout({})).toThrow(CliError);
  });

  test("empty store is a friendly no-op, not an error", () => {
    writeConfig({ profiles: {} });
    expect(() => logout({})).not.toThrow();
  });
});
