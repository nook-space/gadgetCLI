// Integration: list / pull / status / diff against a live instance (GADGET_TEST_URL).

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { freshName, seedRemoteEdit, seedUser, seedWorkspace } from "./seed.js";

const INSTANCE = process.env["GADGET_TEST_URL"];
const run = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");

const home = mkdtempSync(join(tmpdir(), "gadget-read-"));
const work = mkdtempSync(join(tmpdir(), "gadget-work-"));
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

const FILES = {
  "server.js": "export class Gadget { hello() { return 'hi'; } }\n",
  "client.js": "document.body.textContent = 'hi';\n",
  "lib/util.js": "export const n = 1; // héllo 💜\n",
};

describe.skipIf(!INSTANCE)("read path against a live instance", () => {
  let token: string;
  let workspaceId: string;
  let projectDir: string;

  beforeAll(async () => {
    const user = await seedUser(INSTANCE!);
    token = user.token;
    const seeded = await seedWorkspace(INSTANCE!, token, "Read Path WS", [
      { title: "Widget", files: FILES },
    ]);
    workspaceId = seeded.workspaceId;
    // The CLI reads its profile from the config store directly.
    mkdirSync(join(home, "gadget"), { recursive: true });
    writeFileSync(
      join(home, "gadget", "config.json"),
      JSON.stringify({ current: "t", profiles: { t: { url: INSTANCE, token } } }),
    );
    projectDir = join(work, "widget");
    mkdirSync(projectDir);
  }, 60_000);

  test("list shows the workspace; --json parses", async () => {
    const r = await gadget(["list"], work);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Read Path WS");
    const j = await gadget(["--json", "list"], work);
    const parsed = JSON.parse(j.stdout) as { id: string; title: string }[];
    expect(parsed.some((w) => w.id === workspaceId)).toBe(true);
  });

  test("first pull links the directory and materializes every file", async () => {
    const r = await gadget(["pull", workspaceId], projectDir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pulled 3 files at version \d+/);
    for (const [path, content] of Object.entries(FILES)) {
      expect(readFileSync(join(projectDir, path), "utf8")).toBe(content);
    }
    const manifest = JSON.parse(readFileSync(join(projectDir, "gadget.json"), "utf8"));
    expect(manifest).toMatchObject({ profile: "t", workspace: workspaceId, title: "Widget" });
    expect(typeof manifest.root).toBe("string");

    const again = await gadget(["pull"], projectDir);
    expect(again.stdout).toContain("already up to date");
  });

  test("status and diff see a local edit", async () => {
    writeFileSync(join(projectDir, "client.js"), "document.body.textContent = 'howdy';\n");
    const s = await gadget(["status"], projectDir);
    expect(s.stdout.trim()).toBe("M client.js");
    const d = await gadget(["diff"], projectDir);
    expect(d.stdout).toContain("-document.body.textContent = 'hi';");
    expect(d.stdout).toContain("+document.body.textContent = 'howdy';");
  });

  test("pull aborts whole on conflict, writes nothing, then --force overwrites", async () => {
    // Remote edits the same file the local tree changed, and adds a new one.
    await seedRemoteEdit(INSTANCE!, token, workspaceId, undefined, (files) => {
      files.set("client.js", "document.body.textContent = 'remote';\n");
      files.set("added.txt", "from remote\n");
      return files;
    });

    const r = await gadget(["pull"], projectDir);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("client.js");
    // The abort wrote NOTHING — not even the non-conflicting new file.
    expect(existsSync(join(projectDir, "added.txt"))).toBe(false);
    expect(readFileSync(join(projectDir, "client.js"), "utf8")).toContain("howdy");

    const forced = await gadget(["pull", "--force"], projectDir);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(projectDir, "client.js"), "utf8")).toContain("remote");
    expect(readFileSync(join(projectDir, "added.txt"), "utf8")).toBe("from remote\n");
  });

  test("a remote edit elsewhere pulls clean around local dirt", async () => {
    writeFileSync(join(projectDir, "lib", "util.js"), "export const n = 2; // local\n");
    await seedRemoteEdit(INSTANCE!, token, workspaceId, undefined, (files) => {
      files.set("server.js", "export class Gadget { hello() { return 'v2'; } }\n");
      return files;
    });

    const r = await gadget(["pull"], projectDir);
    expect(r.code).toBe(0);
    expect(readFileSync(join(projectDir, "server.js"), "utf8")).toContain("v2");
    // Local dirt on an untouched file survives.
    expect(readFileSync(join(projectDir, "lib", "util.js"), "utf8")).toContain("local");
    const s = await gadget(["status"], projectDir);
    expect(s.stdout.trim()).toBe("M lib/util.js");
  });

  test("several gadgets need --gadget; the flag selects", async () => {
    const two = await seedWorkspace(INSTANCE!, token, "Two Gadgets", [
      { title: "First", files: { "a.js": "1\n" } },
      { title: "Second", files: { "b.js": "2\n" } },
    ]);
    const dir = join(work, freshName("two"));
    mkdirSync(dir);

    const bare = await gadget(["pull", two.workspaceId], dir);
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("First");
    expect(bare.stderr).toContain("Second");

    const picked = await gadget(
      ["pull", two.workspaceId, "--gadget", String(two.gadgetIds[1])],
      dir,
    );
    expect(picked.code).toBe(0);
    expect(readFileSync(join(dir, "b.js"), "utf8")).toBe("2\n");
    expect(existsSync(join(dir, "a.js"))).toBe(false);
  });
});
