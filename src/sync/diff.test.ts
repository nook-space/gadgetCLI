import { describe, expect, test } from "vitest";
import { diffFiles, unifiedDiff } from "./diff.js";

const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("diffFiles", () => {
  test("detects added, modified, deleted — multibyte safe, sorted", () => {
    const base = map({ "a.js": "one", "b.js": "héllo 💜", "c.js": "gone" });
    const local = map({ "a.js": "one", "b.js": "héllo 💙", "d.js": "new" });
    expect(diffFiles(base, local)).toEqual([
      { path: "b.js", kind: "modified" },
      { path: "c.js", kind: "deleted" },
      { path: "d.js", kind: "added" },
    ]);
    expect(diffFiles(base, base)).toEqual([]);
  });
});

describe("unifiedDiff", () => {
  test("stable output with context and elision", () => {
    const from = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const to = ["1", "2", "3", "4", "5x", "6", "7", "8", "9", "10"].join("\n");
    expect(unifiedDiff("f.txt", from, to)).toBe(
      ["--- f.txt", "+++ f.txt", "@@", " 2", " 3", " 4", "-5", "+5x", " 6", " 7", " 8", "@@"].join("\n"),
    );
  });

  test("added and deleted files render as all-plus / all-minus", () => {
    expect(unifiedDiff("n.txt", "", "a\nb")).toContain("+a");
    expect(unifiedDiff("d.txt", "a\nb", "")).toContain("-b");
  });
});
