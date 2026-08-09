// Integration: pack / publish / install / new --from — including the capnweb stream
// spike (importBlueprint upload, downloadBlueprint download) and upstream cross-validation.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseArchive } from "../../src/archive/codec.js";
import { seedUser } from "./seed.js";

const INSTANCE = process.env["GADGET_TEST_URL"];
const run = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");

const home = mkdtempSync(join(tmpdir(), "gadget-bp-"));
const work = mkdtempSync(join(tmpdir(), "gadget-bpwork-"));
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
  "server.js": "export class Gadget { greet() { return 'bonjour 💜'; } }\n",
  "client.js": "document.body.textContent = 'blueprint';\n",
};

const srcDir = join(work, "greeter");
let blueprintUrl: string;
let blueprintId: string;

describe.skipIf(!INSTANCE)("blueprints against a live instance", () => {
  beforeAll(async () => {
    const { token } = await seedUser(INSTANCE!);
    mkdirSync(join(home, "gadget"), { recursive: true });
    writeFileSync(
      join(home, "gadget", "config.json"),
      JSON.stringify({ current: "t", profiles: { t: { url: INSTANCE, token } } }),
    );
    mkdirSync(srcDir);
    for (const [name, content] of Object.entries(FILES)) {
      writeFileSync(join(srcDir, name), content);
    }
    writeFileSync(join(srcDir, "gadget.json"), JSON.stringify({ title: "Greeter" }));
    const pushed = await gadget(["push", "--new"], srcDir);
    expect(pushed.code).toBe(0);
  }, 60_000);

  test("publish refuses a dirty tree, then publishes the pushed code", async () => {
    writeFileSync(join(srcDir, "client.js"), "// dirty\n");
    const dirty = await gadget(["blueprint", "publish"], srcDir);
    expect(dirty.code).toBe(4);
    expect(dirty.stderr).toContain("not pushed");
    writeFileSync(join(srcDir, "client.js"), FILES["client.js"]); // restore

    const r = await gadget(["blueprint", "publish", "--description", "greets"], srcDir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const match = /published blueprint v1: (\S+\/blueprint\/(\S+))/.exec(r.stdout);
    expect(match).not.toBeNull();
    blueprintUrl = match![1]!;
    blueprintId = match![2]!;
  });

  test("new --from downloads over the wire and materializes identical files", async () => {
    // Spike (download half): downloadBlueprint returns a ReadableStream over capnweb.
    const dir = join(work, "clone");
    const r = await gadget(["new", "clone", "--from", blueprintUrl], work);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    for (const [name, content] of Object.entries(FILES)) {
      expect(readFileSync(join(dir, name), "utf8")).toBe(content);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "gadget.json"), "utf8"));
    expect(manifest.title).toBe("Greeter");
    expect(manifest.workspace).toBeUndefined(); // a copy, not a link
  });

  test("install instantiates a zero-binding blueprint; pull covers the legacy root", async () => {
    const r = await gadget(["install", blueprintId], work);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const wsMatch = /\/workspace\/(\S+)/.exec(r.stdout);
    expect(wsMatch).not.toBeNull();

    // Blueprint instantiation creates the workspace's DEFAULT gadget — the legacy ""
    // files root — so this pull exercises the root form the write path cannot.
    const dir = join(work, "installed");
    mkdirSync(dir);
    const pulled = await gadget(["pull", wsMatch![1]!], dir);
    expect(pulled.code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "gadget.json"), "utf8"));
    expect(manifest.root).toBe("");
    for (const [name, content] of Object.entries(FILES)) {
      expect(readFileSync(join(dir, name), "utf8")).toBe(content);
    }
  });

  test("pack → archive publish (spike: upload stream) → new --from roundtrip", async () => {
    const packed = await gadget(["pack", "--out", "greeter.gadget"], srcDir);
    expect(packed.code).toBe(0);

    // Local parse sanity before the wire.
    const bytes = readFileSync(join(srcDir, "greeter.gadget"));
    const parsed = parseArchive(bytes);
    expect([...parsed.files.keys()].sort()).toEqual(["client.js", "server.js"]);

    // Spike (upload half): importBlueprint takes a ReadableStream over capnweb.
    const imported = await gadget(
      ["blueprint", "publish", "--archive", "greeter.gadget"],
      srcDir,
    );
    expect(imported.stderr).toBe("");
    expect(imported.code).toBe(0);
    const idMatch = /\/blueprint\/(\S+)/.exec(imported.stdout);
    expect(idMatch).not.toBeNull();
    expect(idMatch![1]).not.toBe(blueprintId); // create-only: a new id every time

    // Cross-validate: the instance-side copy of OUR archive materializes identically.
    const dir = join(work, "reimported");
    const r = await gadget(["new", "reimported", "--from", `${INSTANCE}/blueprint/${idMatch![1]}`], work);
    expect(r.code).toBe(0);
    for (const [name, content] of Object.entries(FILES)) {
      expect(readFileSync(join(dir, name), "utf8")).toBe(content);
    }
  });

  test("publish --update bumps the version at the same URL", async () => {
    writeFileSync(join(srcDir, "server.js"), "export class Gadget { greet() { return 'v2'; } }\n");
    expect((await gadget(["push"], srcDir)).code).toBe(0);
    const r = await gadget(["blueprint", "publish", "--update", blueprintId], srcDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(blueprintId);

    const dir = join(work, "v2clone");
    expect((await gadget(["new", "v2clone", "--from", blueprintUrl], work)).code).toBe(0);
    expect(readFileSync(join(dir, "server.js"), "utf8")).toContain("v2");
  });

  test("a stale base refuses to publish", async () => {
    // Another clone pushes; the original (now stale) tries to publish.
    const dir = join(work, "stale");
    mkdirSync(dir);
    const manifest = JSON.parse(readFileSync(join(srcDir, "gadget.json"), "utf8"));
    expect((await gadget(["pull", manifest.workspace], dir)).code).toBe(0);
    writeFileSync(join(dir, "client.js"), "// moved on\n");
    expect((await gadget(["push"], dir)).code).toBe(0);

    const r = await gadget(["blueprint", "publish"], srcDir);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("moved past");
  });
});
