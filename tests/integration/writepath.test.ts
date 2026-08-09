// Integration: new / push --new / push / open — two clients converging on one gadget.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { seedRemoteEdit, seedUser, seedWorkspace } from "./seed.js";
import { spawn } from "node:child_process";

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

  test("push --force wins a same-file race (last writer)", async () => {
    writeFileSync(join(dirA, "server.js"), "// A v2\n");
    expect((await gadget(["push"], dirA)).code).toBe(0);
    writeFileSync(join(dirB, "server.js"), "// B v2\n");
    const forced = await gadget(["push", "--force"], dirB);
    expect(forced.code).toBe(0);
    expect((await gadget(["pull"], dirA)).code).toBe(0);
    expect(readFileSync(join(dirA, "server.js"), "utf8")).toBe("// B v2\n");
  });

  // Regression (phase-3 critique should-fix 1): identical content is convergence.
  test("both clones reaching the same text is not a conflict", async () => {
    writeFileSync(join(dirA, "server.js"), "// same everywhere\n");
    writeFileSync(join(dirB, "server.js"), "// same everywhere\n");
    expect((await gadget(["push"], dirA)).code).toBe(0);
    // B's base is stale and B is dirty on the same file — but the texts are equal.
    const converged = await gadget(["push"], dirB);
    expect(converged.code).toBe(0);
    const pullB = await gadget(["pull"], dirB);
    expect(pullB.code).toBe(0);
    expect((await gadget(["status"], dirB)).stdout.trim()).toBe("clean");
  });

  // Regression (phase-3 critique should-fix 3): the refusal rule ignores other roots,
  // and a no-op push still advances the stored version.
  test("edits to another gadget's root never refuse a push", async () => {
    const config = JSON.parse(readFileSync(join(home, "gadget", "config.json"), "utf8"));
    const two = await seedWorkspace(INSTANCE!, config.profiles.t.token, "Cross Root", [
      { title: "Alpha", files: { "a.js": "a1\n" } },
      { title: "Beta", files: { "b.js": "b1\n" } },
    ]);
    const dir = join(work, "alpha");
    mkdirSync(dir);
    expect(
      (await gadget(["pull", two.workspaceId, "--gadget", String(two.gadgetIds[0])], dir)).code,
    ).toBe(0);

    await seedRemoteEdit(INSTANCE!, config.profiles.t.token, two.workspaceId, two.gadgetIds[1],
      (files) => files.set("b.js", "b2\n") && files);

    writeFileSync(join(dir, "a.js"), "a2\n");
    const r = await gadget(["push"], dir);
    expect(r.code).toBe(0); // beta's update must not refuse alpha's push

    const before = JSON.parse(readFileSync(join(dir, ".gadget", "state.json"), "utf8")).version;
    await seedRemoteEdit(INSTANCE!, config.profiles.t.token, two.workspaceId, two.gadgetIds[1],
      (files) => files.set("b.js", "b3\n") && files);
    const noop = await gadget(["push"], dir);
    expect(noop.stdout).toContain("nothing to push");
    const after = JSON.parse(readFileSync(join(dir, ".gadget", "state.json"), "utf8")).version;
    expect(after).toBeGreaterThan(before);
  });

  // Regression (phase-3 critique should-fix 4): typed openGadget codes render.
  test("workspace not-found exits 2; access to a stranger's workspace exits 3", async () => {
    const bogus = await gadget(["pull", "nosuchworkspace123"], join(work, "."));
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("workspace not found");

    const stranger = await seedUser(INSTANCE!);
    const config = JSON.parse(readFileSync(join(home, "gadget", "config.json"), "utf8"));
    config.profiles["u"] = { url: INSTANCE, token: stranger.token };
    writeFileSync(join(home, "gadget", "config.json"), JSON.stringify(config));
    const deniedDir = join(work, "denied");
    mkdirSync(deniedDir);
    const denied = await gadget(["pull", workspaceId, "--profile", "u"], deniedDir);
    expect(denied.code).toBe(3);
    expect(denied.stderr).toContain("access");
  });

  // Regression (phase-3 critique should-fix 2+5): a foreign edit inside the push
  // window warns AND keeps the pre-resync base, so the next push refuses.
  test("in-window foreign edits warn and un-blind the next push", async () => {
    writeFileSync(join(dirA, "client.js"), "// window test\n");
    const config = JSON.parse(readFileSync(join(home, "gadget", "config.json"), "utf8"));

    const child = spawn(process.execPath, [BIN, "push"], {
      cwd: dirA,
      env: { ...process.env, XDG_CONFIG_HOME: home, GADGET_TEST_HOLD_AFTER_PUSH: "2500" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const err: string[] = [];
    child.stderr.on("data", (d) => err.push(String(d)));
    await new Promise((r) => setTimeout(r, 800)); // let updateCode land, then edit inside the hold
    await seedRemoteEdit(INSTANCE!, config.profiles.t.token, workspaceId, undefined,
      (files) => files.set("window.txt", "foreign\n") && files);
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).toBe(0);
    expect(err.join("")).toContain("changed during the push");

    // The base was NOT advanced over the unmaterialized foreign file: pushing again
    // refuses until a pull materializes it.
    writeFileSync(join(dirA, "client.js"), "// after window\n");
    const next = await gadget(["push"], dirA);
    expect(next.code).toBe(4);
    expect(next.stderr).toContain("window.txt");
    expect((await gadget(["pull"], dirA)).code).toBe(0);
    expect(readFileSync(join(dirA, "window.txt"), "utf8")).toBe("foreign\n");
    expect((await gadget(["push"], dirA)).code).toBe(0);
  });
});
