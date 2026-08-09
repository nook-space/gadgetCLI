// Integration: drives the built CLI against a live instance (GADGET_TEST_URL).
// Skipped when GADGET_TEST_URL is unset. Fresh identities per run; never assumes a clean server.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const INSTANCE = process.env["GADGET_TEST_URL"];
const run = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");

const home = mkdtempSync(join(tmpdir(), "gadget-int-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function gadget(args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, [BIN, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home, ...env },
  }).then(
    (r) => ({ ...r, code: 0 }),
    (err: Error & { code?: number; stdout: string; stderr: string }) =>
      ({ stdout: err.stdout, stderr: err.stderr, code: err.code ?? 1 }),
  );
}

const user = `cli${Date.now()}${process.pid}`;
const password = "s3cret pw!";

describe.skipIf(!INSTANCE)("auth against a live instance", () => {
  test("login --create signs up, verifies, and stores the profile", async () => {
    const r = await gadget(["login", INSTANCE!, "--create", "--username", user], {
      GADGET_PASSWORD: password,
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`logged in as ${user}`);

    const config = JSON.parse(readFileSync(join(home, "gadget", "config.json"), "utf8"));
    const profile = config.profiles[config.current];
    expect(profile.token).toMatch(/^.+:.+$/); // "<user>:<secret>"
  });

  test("whoami works from a fresh process using the stored token", async () => {
    const r = await gadget(["whoami"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(user);
  });

  test("doctor reports auth ok with a workspace count", async () => {
    const r = await gadget(["doctor", INSTANCE!]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/auth\s+ok — /);
  });

  test("re-login (no --create) succeeds with the same credentials", async () => {
    const r = await gadget(["login", INSTANCE!, "--username", user], {
      GADGET_PASSWORD: password,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("logged in as");
  });

  test("--create on a taken username exits 3 with a hint", async () => {
    const r = await gadget(["login", INSTANCE!, "--create", "--username", user], {
      GADGET_PASSWORD: password,
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("already taken");
  });

  test("a wrong password exits 3 and hints at case-sensitivity", async () => {
    const r = await gadget(["login", INSTANCE!, "--username", user], {
      GADGET_PASSWORD: "wrong",
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("wrong username or password");
    expect(r.stderr).toContain("case-sensitive");
  });

  test("a corrupted token is rejected with a login hint, exit 3", async () => {
    const path = join(home, "gadget", "config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.profiles[config.current].token = `${user}:AAAA`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(config));

    const r = await gadget(["whoami"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("rejected");
    expect(r.stderr).toContain("gadget login");
  });
});
