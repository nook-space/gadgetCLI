import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { docFiles, materialize, readLocalFiles, validateFileName } from "./files.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "gadget-files-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("validateFileName", () => {
  test("rejects traversal, absolute, backslash, and empty-segment names", () => {
    for (const bad of ["../x", "a/../b", "/etc/passwd", "a\\b", "", "a//b", "./a"]) {
      expect(() => validateFileName(bad), bad).toThrow(/unsafe file name/);
    }
    for (const good of ["server.js", "lib/util.js", "docs/notes.md"]) {
      expect(() => validateFileName(good)).not.toThrow();
    }
  });
});

describe("readLocalFiles", () => {
  test("walks subdirs, skips ignores and dotfiles", () => {
    writeFileSync(join(dir, "server.js"), "s");
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "util.js"), "u");
    writeFileSync(join(dir, "gadget.json"), "{}");
    writeFileSync(join(dir, ".DS_Store"), "junk");
    mkdirSync(join(dir, ".gadget"));
    writeFileSync(join(dir, ".gadget", "state.json"), "{}");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "n");
    mkdirSync(join(dir, "mocks"));
    writeFileSync(join(dir, "mocks", "env.js"), "m");

    expect([...readLocalFiles(dir).keys()].sort()).toEqual(["lib/util.js", "server.js"]);
  });

  test("rejects non-UTF-8 and oversized files by name", () => {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0xc1]));
    expect(() => readLocalFiles(dir)).toThrow(/not UTF-8 text: bin\.dat/);
    rmSync(join(dir, "bin.dat"));
    writeFileSync(join(dir, "big.txt"), "x".repeat(1024 * 1024 + 1));
    expect(() => readLocalFiles(dir)).toThrow(/too large.*big\.txt/);
  });
});

describe("docFiles + materialize", () => {
  test("reads a root map and writes/deletes only the named paths", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.Text>("");
    root.set("a.txt", new Y.Text("A"));
    root.set("lib/b.txt", new Y.Text("B"));

    const files = docFiles(doc, "");
    materialize(dir, files, files.keys());
    expect(readLocalFiles(dir).get("lib/b.txt")).toBe("B");

    files.delete("a.txt");
    materialize(dir, files, ["a.txt"]);
    expect(readLocalFiles(dir).has("a.txt")).toBe(false);
    expect(readLocalFiles(dir).get("lib/b.txt")).toBe("B");
  });

  test("a hostile doc root cannot escape the project directory", () => {
    const doc = new Y.Doc();
    doc.getMap<Y.Text>("").set("../evil.txt", new Y.Text("x"));
    expect(() => docFiles(doc, "")).toThrow(/unsafe file name/);
  });
});
