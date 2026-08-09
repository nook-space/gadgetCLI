import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import type { WorkpieceSummary } from "../remote/types.js";
import { docFiles } from "./files.js";
import { buildUpdate, filesRootOf, resolveGadget } from "./engine.js";

const gadget = (id: number, extra: Partial<WorkpieceSummary> = {}): WorkpieceSummary => ({
  id,
  type: "gadget",
  title: `g${id}`,
  filesRoot: String(id),
  ...extra,
});

describe("resolveGadget", () => {
  test("sole gadget links; several demand --gadget with an id+title list", () => {
    expect(resolveGadget([gadget(2)]).id).toBe(2);
    expect(() => resolveGadget([gadget(2), gadget(5)])).toThrow(
      expect.objectContaining({ hint: expect.stringContaining("2: g2, 5: g5") }),
    );
    expect(resolveGadget([gadget(2), gadget(5)], 5).id).toBe(5);
    expect(() => resolveGadget([gadget(2)], 9)).toThrow(/no gadget 9/);
  });

  test("chat-provisional gadgets are never selectable", () => {
    expect(resolveGadget([gadget(2, { chatId: 1 }), gadget(5)]).id).toBe(5);
    expect(() => resolveGadget([gadget(2, { chatId: 1 })])).toThrow(/no gadgets/);
  });

  test("filesRootOf trusts the summary for both root forms and never computes", () => {
    expect(filesRootOf(gadget(7))).toBe("7");
    expect(filesRootOf(gadget(7, { filesRoot: "" }))).toBe("");
    expect(() => filesRootOf(gadget(7, { filesRoot: undefined }))).toThrow(/no files root/);
  });
});

describe("buildUpdate", () => {
  test("replace/add/delete land as one update that applies cleanly to a copy", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.Text>("3");
    root.set("keep.js", new Y.Text("same"));
    root.set("change.js", new Y.Text("old"));
    root.set("drop.js", new Y.Text("bye"));
    const before = Y.encodeStateAsUpdateV2(doc);

    const update = buildUpdate(doc, "3", new Map([
      ["keep.js", "same"],
      ["change.js", "new content"],
      ["added.js", "hello"],
    ]));
    expect(update).not.toBeNull();

    const copy = new Y.Doc();
    Y.applyUpdateV2(copy, before);
    Y.applyUpdateV2(copy, update!);
    expect(docFiles(copy, "3")).toEqual(new Map([
      ["keep.js", "same"],
      ["change.js", "new content"],
      ["added.js", "hello"],
    ]));
  });

  test("a no-op set emits nothing", () => {
    const doc = new Y.Doc();
    doc.getMap<Y.Text>("").set("a.js", new Y.Text("x"));
    expect(buildUpdate(doc, "", new Map([["a.js", "x"]]))).toBeNull();
  });

  test("unsafe names are rejected before touching the doc", () => {
    const doc = new Y.Doc();
    expect(() => buildUpdate(doc, "", new Map([["../evil", "x"]]))).toThrow(/unsafe file name/);
  });
});
