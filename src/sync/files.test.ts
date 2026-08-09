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
    writeFileSync(join(dir, "export.gadget"), Buffer.from([0xec, 0x2e])); // pack output

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
    // ".." segments are dot-prefixed, so the ignore filter excludes them from
    // tracking before validation ever runs...
    doc.getMap<Y.Text>("").set("../evil.txt", new Y.Text("x"));
    expect(docFiles(doc, "").size).toBe(0);
    // ...names that are tracked but unsafe still throw...
    doc.getMap<Y.Text>("").set("a\\b.txt", new Y.Text("x"));
    expect(() => docFiles(doc, "")).toThrow(/unsafe file name/);
    // ...and materialize validates every path it is handed, independently.
    expect(() => materialize(dir, new Map([["../evil.txt", "x"]]), ["../evil.txt"]))
      .toThrow(/unsafe file name/);
  });

  // Regression (phase-2 critique blocker): the ignore set applies to the DOC side too.
  test("ignored doc entries are invisible: not read, not diffed, not materialized", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.Text>("");
    root.set("server.js", new Y.Text("s"));
    root.set(".prettierrc", new Y.Text("{}"));
    root.set("mocks/env.js", new Y.Text("m"));
    root.set("../broken-but-ignored/.x", new Y.Text("x")); // ignored before validation

    const files = docFiles(doc, "");
    expect([...files.keys()]).toEqual(["server.js"]);
  });

  test("doc names that collide on a case-insensitive filesystem are refused", () => {
    const doc = new Y.Doc();
    doc.getMap<Y.Text>("").set("App.js", new Y.Text("1"));
    doc.getMap<Y.Text>("").set("app.js", new Y.Text("2"));
    expect(() => docFiles(doc, "")).toThrow(/collide/);
  });

  // Regression (phase-2 critique should-fix): no write travels through a symlink.
  test("materialize refuses to write through a symlinked subdirectory", async () => {
    const { symlinkSync } = await import("node:fs");
    const outside = mkdtempSync(join(tmpdir(), "gadget-outside-"));
    try {
      symlinkSync(outside, join(dir, "lib"));
      const files = new Map([["lib/pwned.js", "ESCAPED"]]);
      expect(() => materialize(dir, files, files.keys())).toThrow(/symlink/);
      expect(readLocalFiles(outside).size).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
