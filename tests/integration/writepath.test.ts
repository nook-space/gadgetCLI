// Integration: new / push --new / push / open — two clients converging on one gadget.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { seedUser } from "./seed.js";

const INSTANCE = process.env["GADGET_TEST_URL"];
const run = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");

const home = mkdtempSync(join(tmpdir(), "gadget-write-"));
const work = mkdtempSync(join(tmpdir(), "gadget-wwork-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function gadget(args: string[], cwd: string) {
  return run(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: home },
  }).then(
    (r) => ({ ...r, code: 0 }),
    (err: Error & { code?: number; stdout: string; stderr: string }) =>
      ({ stdout: err.stdout, stderr: err.stderr, code: err.code ?? 1 }),
  );
}

const dirA = join(work, "tracker");
const dirB = join(work, "tracker-b");
let workspaceId: string;

describe.skipIf(!INSTANCE)("write path against a live instance", () => {
  beforeAll(async () => {
    const { token } = await seedUser(INSTANCE!);
    mkdirSync(join(home, "gadget"), { recursive: true });
    writeFileSync(
      join(home, "gadget", "config.json"),
      JSON.stringify({ current: "t", profiles: { t: { url: INSTANCE, token } } }),
    );
  }, 60_000);

  test("new scaffolds; a second new into the same dir refuses", async () => {
    const r = await gadget(["new", "tracker"], work);
    expect(r.code).toBe(0);
    for (const f of ["server.js", "client.js", "README.md", "gadget.json"]) {
      expect(existsSync(join(dirA, f))).toBe(true);
    }
    expect((await gadget(["new", "tracker"], work)).code).toBe(2);
  });

  test("push --new creates workspace + gadget, links, and prints the URL", async () => {
    const r = await gadget(["push", "--new"], dirA);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created workspace .+ \("tracker"\)/);
    expect(r.stdout).toMatch(/pushed 3 files at version \d+/);

    const manifest = JSON.parse(readFileSync(join(dirA, "gadget.json"), "utf8"));
    workspaceId = manifest.workspace;
    expect(manifest).toMatchObject({ title: "tracker", profile: "t" });
    expect(typeof manifest.gadget).toBe("number");
    expect(typeof manifest.root).toBe("string");

    expect((await gadget(["push", "--new"], dirA)).code).toBe(2); // already linked
    const open = await gadget(["open"], dirA);
    expect(open.stdout).toContain(`/workspace/${workspaceId}`);
  });

  test("a second clone pulls the pushed files identically", async () => {
    mkdirSync(dirB);
    const r = await gadget(["pull", workspaceId], dirB);
    expect(r.code).toBe(0);
    for (const f of ["server.js", "client.js", "README.md"]) {
      expect(readFileSync(join(dirB, f), "utf8")).toBe(readFileSync(join(dirA, f), "utf8"));
    }
  });

  test("stale push refuses with a pull hint; pull-then-push converges", async () => {
    // A edits server.js and pushes; B (stale base) edits client.js.
    writeFileSync(join(dirA, "server.js"), "// A was here — héllo 💜\n");
    const pushA = await gadget(["push"], dirA);
    expect(pushA.code).toBe(0);

    writeFileSync(join(dirB, "client.js"), "// B was here\n");
    const stale = await gadget(["push"], dirB);
    expect(stale.code).toBe(4);
    expect(stale.stderr).toContain("server.js");
    expect(stale.stderr).toContain("gadget pull");

    // B pulls (clean: different files), pushes, and both sides converge.
    expect((await gadget(["pull"], dirB)).code).toBe(0);
    expect(readFileSync(join(dirB, "server.js"), "utf8")).toContain("A was here");
    expect((await gadget(["push"], dirB)).code).toBe(0);
    expect((await gadget(["pull"], dirA)).code).toBe(0);
    expect(readFileSync(join(dirA, "client.js"), "utf8")).toBe("// B was here\n");
    expect(readFileSync(join(dirA, "server.js"), "utf8")).toBe("// A was here — héllo 💜\n");
    expect((await gadget(["status"], dirA)).stdout.trim()).toBe("clean");
  });

  test("deletes propagate; nothing-to-push is a no-op", async () => {
    rmSync(join(dirA, "README.md"));
    const r = await gadget(["push"], dirA);
    expect(r.code).toBe(0);
    expect((await gadget(["pull"], dirB)).code).toBe(0);
    expect(existsSync(join(dirB, "README.md"))).toBe(false);

    const noop = await gadget(["push"], dirA);
    expect(noop.code).toBe(0);
    expect(noop.stdout).toContain("nothing to push");
  });

  test("push --force wins a same-file race, and the loser survives in history", async () => {
    writeFileSync(join(dirA, "server.js"), "// A v2\n");
    expect((await gadget(["push"], dirA)).code).toBe(0);
    writeFileSync(join(dirB, "server.js"), "// B v2\n");
    const forced = await gadget(["push", "--force"], dirB);
    expect(forced.code).toBe(0);
    expect((await gadget(["pull"], dirA)).code).toBe(0);
    expect(readFileSync(join(dirA, "server.js"), "utf8")).toBe("// B v2\n");
  });
});
