import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findProject, loadManifest, loadState, saveManifest, saveState } from "./state.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "gadget-state-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("manifest io", () => {
  test("round-trips and finds the project from a subdirectory", () => {
    saveManifest(dir, { title: "t", profile: "p", workspace: "w", gadget: 3, root: "3" });
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    const found = findProject(join(dir, "a", "b"));
    expect(found?.dir).toBe(dir);
    expect(found?.manifest.gadget).toBe(3);
    expect(findProject(tmpdir())).toBeUndefined();
  });

  test("corrupt and misshapen manifests fail with the path named", () => {
    writeFileSync(join(dir, "gadget.json"), "{nope");
    expect(() => loadManifest(dir)).toThrow(/not valid JSON/);
    writeFileSync(join(dir, "gadget.json"), '{"title":42}');
    expect(() => loadManifest(dir)).toThrow(/unexpected shape/);
  });
});

describe("state codec", () => {
  test("round-trips the doc and version, atomically", () => {
    const doc = new Y.Doc();
    doc.getMap<Y.Text>("7").set("server.js", new Y.Text("export {}"));
    saveState(dir, 42, doc);

    const loaded = loadState(dir);
    expect(loaded?.version).toBe(42);
    expect(loaded?.doc.getMap<Y.Text>("7").get("server.js")?.toString()).toBe("export {}");
    // No stray tmp files after a save.
    expect(readdirSync(join(dir, ".gadget")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("missing state is undefined; corrupt state names the file with a reset hint", () => {
    expect(loadState(dir)).toBeUndefined();
    mkdirSync(join(dir, ".gadget"), { recursive: true });
    writeFileSync(join(dir, ".gadget", "state.json"), '{"version":"x"}');
    expect(() => loadState(dir)).toThrow(/state is corrupt/);
    writeFileSync(join(dir, ".gadget", "state.json"), '{"version":1,"doc":"!!!notbase64doc"}');
    expect(() => loadState(dir)).toThrow(/state is corrupt/);
  });
});
