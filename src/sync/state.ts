// Project persistence: gadget.json (the manifest, committed) and .gadget/state.json
// (the sync base: whole-workspace Y.Doc + last synced version, gitignored).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, parse } from "node:path";
import * as Y from "yjs";
import { CliError } from "../errors.js";

// `profile`/`workspace`/`gadget`/`root` are absent until the project is linked
// (first `pull <id>` or `push --new`). `root` is the gadget's files-root name in the
// workspace doc, recorded at link time so offline commands never guess it.
export type Manifest = {
  title: string;
  profile?: string;
  workspace?: string;
  gadget?: number;
  root?: string;
};

export type ProjectState = { version: number; doc: Y.Doc };

export const MANIFEST_FILE = "gadget.json";
const STATE_FILE = join(".gadget", "state.json");

// Walk up from `start` to the nearest directory holding a gadget.json.
export function findProject(start: string): { dir: string; manifest: Manifest } | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = loadManifest(dir);
    if (manifest) return { dir, manifest };
    if (dir === parse(dir).root) return undefined;
  }
}

export function loadManifest(dir: string): Manifest | undefined {
  const path = join(dir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(`cannot read ${path}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`manifest is not valid JSON: ${path}`);
  }
  const m = parsed as Manifest;
  const ok =
    typeof m === "object" && m !== null &&
    typeof m.title === "string" &&
    ["string", "undefined"].includes(typeof m.profile) &&
    ["string", "undefined"].includes(typeof m.workspace) &&
    ["number", "undefined"].includes(typeof m.gadget) &&
    ["string", "undefined"].includes(typeof m.root);
  if (!ok) throw new CliError(`manifest has an unexpected shape: ${path}`);
  return m;
}

export function saveManifest(dir: string, manifest: Manifest): void {
  atomicWrite(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
}

export function loadState(dir: string): ProjectState | undefined {
  const path = join(dir, STATE_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(`cannot read ${path}`, { cause: err });
  }
  let version: number, docB64: string;
  try {
    const parsed = JSON.parse(raw) as { version: number; doc: string };
    version = parsed.version;
    docB64 = parsed.doc;
    if (!Number.isInteger(version) || typeof docB64 !== "string") throw new Error("bad shape");
  } catch {
    throw new CliError(`sync state is corrupt: ${path}`, {
      hint: "delete the .gadget directory and run gadget pull again",
    });
  }
  const doc = new Y.Doc();
  try {
    Y.applyUpdateV2(doc, Buffer.from(docB64, "base64"));
  } catch (cause) {
    throw new CliError(`sync state is corrupt: ${path}`, {
      cause,
      hint: "delete the .gadget directory and run gadget pull again",
    });
  }
  return { version, doc };
}

export function saveState(dir: string, version: number, doc: Y.Doc): void {
  const body = JSON.stringify({
    version,
    doc: Buffer.from(Y.encodeStateAsUpdateV2(doc)).toString("base64"),
  });
  atomicWrite(join(dir, STATE_FILE), body + "\n");
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
