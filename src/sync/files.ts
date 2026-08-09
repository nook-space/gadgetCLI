// The boundary between gadget files and the local disk: reading a project tree,
// materializing doc contents, and the safety rules (path guards, UTF-8, size cap).

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type * as Y from "yjs";
import { CliError } from "../errors.js";
import { MANIFEST_FILE } from "./state.js";

export const MAX_FILE_BYTES = 1024 * 1024;

// Top-level entries never synced; dot-prefixed entries are skipped at every level
// (covers .git, .gadget, .DS_Store — and keeps the git lane separate from the gadget lane).
const IGNORE_TOP_LEVEL = new Set([MANIFEST_FILE, "node_modules", "mocks"]);

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
export function readLocalFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (rel === "" && IGNORE_TOP_LEVEL.has(entry.name)) continue;
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
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

// Read a gadget's files out of the workspace doc: root map name → file map.
export function docFiles(doc: Y.Doc, root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const [name, text] of doc.getMap<Y.Text>(root)) {
    validateFileName(name);
    files.set(name, text.toString());
  }
  return files;
}

// Write `content` for each path in `paths` from `files`, deleting paths absent there.
export function materialize(
  dir: string,
  files: Map<string, string>,
  paths: Iterable<string>,
): void {
  for (const path of paths) {
    validateFileName(path);
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
