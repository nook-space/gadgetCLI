// The boundary between gadget files and the local disk: reading a project tree,
// materializing doc contents, and the safety rules (path guards, UTF-8, size cap).

import {
  lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import type * as Y from "yjs";
import { CliError } from "../errors.js";
import { MANIFEST_FILE } from "./state.js";

export const MAX_FILE_BYTES = 1024 * 1024;

// Top-level entries never synced. `mocks/` is a CLI-local reservation for the future
// local harness (see idea.md); the rest keep tool state out of gadget content.
const IGNORE_TOP_LEVEL = new Set([MANIFEST_FILE, "node_modules", "mocks"]);

// The ONE tracking rule, applied to BOTH sides of every diff: local tree and doc.
// Dot-prefixed entries are ignored at every level (.git, .gadget, .DS_Store — and the
// git lane stays separate from the gadget lane), and so are *.gadget archives (pack's
// output is an export, never gadget content). Ignored doc entries are never
// materialized, diffed, or deleted by a push.
export function isIgnored(path: string): boolean {
  const segments = path.split("/");
  if (IGNORE_TOP_LEVEL.has(segments[0]!)) return true;
  return segments.some((seg) => seg.startsWith(".") || seg.endsWith(".gadget"));
}

// A gadget file name is a relative path with forward slashes: no absolute paths, no
// "..", no empty segments, no backslashes. Enforced in BOTH directions — a hostile
// workspace doc must not write outside the project, and a local tree must not push
// names the workshop cannot render.
export function validateFileName(name: string): void {
  const bad =
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (bad) throw new CliError(`unsafe file name in gadget: ${JSON.stringify(name)}`);
}

// Read every tracked file under `dir` → path (forward slashes) → text.
// Symlinks are never followed (readdir withFileTypes reports them as symlinks).
export function readLocalFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (isIgnored(relPath)) continue;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const full = join(dir, relPath.split("/").join(sep));
      if (statSync(full).size > MAX_FILE_BYTES) {
        throw new CliError(`file too large to sync (max 1 MiB): ${relPath}`);
      }
      try {
        files.set(relPath, decoder.decode(readFileSync(full)));
      } catch {
        throw new CliError(`not UTF-8 text: ${relPath}`, {
          hint: "gadget files are text; move binary assets out of the project",
        });
      }
    }
  };
  walk("");
  return files;
}

// Read a gadget's TRACKED files out of the workspace doc: ignored entries are
// filtered before validation, so a broken ignored name cannot block a pull; the
// names that remain must be safe. Collisions that would merge onto one file on a
// case-insensitive or normalizing filesystem (APFS) are refused outright.
export function docFiles(doc: Y.Doc, root: string): Map<string, string> {
  const files = new Map<string, string>();
  const folded = new Map<string, string>();
  for (const [name, text] of doc.getMap<Y.Text>(root)) {
    if (isIgnored(name)) continue;
    validateFileName(name);
    const fold = name.normalize("NFC").toLowerCase();
    const existing = folded.get(fold);
    if (existing !== undefined) {
      throw new CliError(
        `gadget file names collide on this filesystem: ${existing}, ${name}`,
        { hint: "rename one of them in the workshop" },
      );
    }
    folded.set(fold, name);
    files.set(name, text.toString());
  }
  return files;
}

// Write `content` for each path in `paths` from `files`, deleting paths absent there.
// No write or delete ever travels through a symlinked component — a pre-existing
// local symlink must not let doc content land outside the project.
export function materialize(
  dir: string,
  files: Map<string, string>,
  paths: Iterable<string>,
): void {
  for (const path of paths) {
    validateFileName(path);
    assertNoSymlinks(dir, path);
    const full = join(dir, path.split("/").join(sep));
    const content = files.get(path);
    if (content === undefined) {
      rmSync(full, { force: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

function assertNoSymlinks(dir: string, path: string): void {
  const segments = path.split("/");
  let current = dir;
  for (const segment of segments) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return; // rest of the path does not exist yet — nothing to traverse through
    }
    if (stat.isSymbolicLink()) {
      throw new CliError(`refusing to write through a symlink: ${path}`, {
        hint: "remove the symlink from the project directory",
      });
    }
  }
}
