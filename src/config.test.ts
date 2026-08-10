import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configPath, loadConfig, resolveProfile, saveConfig } from "./config.js";
import { CliError } from "./errors.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gadget-test-"));
  process.env["XDG_CONFIG_HOME"] = dir;
});

afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(dir, { recursive: true, force: true });
});

describe("config store", () => {
  test("missing file loads as empty config", () => {
    expect(loadConfig()).toEqual({ profiles: {} });
  });

  test("round-trips and writes 0600", () => {
    const config = { current: "dev", profiles: { dev: { url: "http://localhost:8787", token: "t" } } };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath(), "utf8")).toContain("localhost");
  });

  test("corrupt file fails with the file named", () => {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), "{nope");
    expect(() => loadConfig()).toThrow(/not valid JSON.*config\.json/);
  });

  test("valid JSON with a wrong shape is rejected, not crashed on", () => {
    mkdirSync(dirname(configPath()), { recursive: true });
    for (const bad of [
      '{"profiles":null}',
      '{"profiles":[]}',
      '{"profiles":{"a":{"url":42}}}',
      '{"profiles":{"a":{"url":"https://x","access":"yes"}}}',
    ]) {
      writeFileSync(configPath(), bad);
      expect(() => loadConfig()).toThrow(/unexpected shape/);
    }
  });

  test("a Cloudflare Access profile round-trips and stores no token", () => {
    // Access is the identity: nothing secret goes to disk, unlike password/OAuth.
    const config = { current: "nook", profiles: { nook: { url: "https://nook.example", access: true } } };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
    expect(JSON.stringify(loadConfig())).not.toContain("token");
  });

  test("unreadable file is an error, not a logged-out state", () => {
    mkdirSync(configPath(), { recursive: true }); // a directory at the file's path → EISDIR
    expect(() => loadConfig()).toThrow(/cannot read config file/);
  });
});

describe("resolveProfile", () => {
  const two = { profiles: { a: { url: "https://a" }, b: { url: "https://b" } } };

  test("explicit name wins; unknown name lists known ones", () => {
    expect(resolveProfile(two, "b").profile.url).toBe("https://b");
    expect(() => resolveProfile(two, "c")).toThrow(CliError);
  });

  test("falls back to current, then to a sole profile", () => {
    expect(resolveProfile({ ...two, current: "a" }).name).toBe("a");
    expect(resolveProfile({ profiles: { only: { url: "https://x" } } }).name).toBe("only");
  });

  test("empty store says log in (auth); several say pick (usage)", () => {
    expect(() => resolveProfile({ profiles: {} })).toThrow(
      expect.objectContaining({ exitCode: 3 }),
    );
    expect(() => resolveProfile(two)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
});
