import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import * as Y from "yjs";
import { loadConfig, resolveProfile } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";
import {
  MAX_CONTENT_BYTES, MAX_METADATA_BYTES, packArchive, parseArchive,
} from "../../archive/codec.js";
import { openAuthed } from "../../remote/authed.js";
import { instanceOrigin, openSession } from "../../remote/session.js";
import type { BlueprintMetadata } from "../../remote/types.js";
import { diffFiles } from "../../sync/diff.js";
import { docFiles, materialize, readLocalFiles } from "../../sync/files.js";
import { fetchCode, filesRootOf, listWorkpieces, openWorkspace, resolveGadget } from "../../sync/engine.js";
import { findProject, loadManifest, saveManifest } from "../../sync/state.js";
import { requireLinkedProject } from "../project.js";

// --- pack -------------------------------------------------------------------

export type PackOptions = { out?: string; title?: string; description?: string; profile?: string };

export async function pack(opts: PackOptions): Promise<void> {
  const cwd = process.cwd();
  const found = findProject(cwd);
  const dir = found?.dir ?? cwd;
  const files = readLocalFiles(dir);
  if (files.size === 0) throw new CliError("nothing to pack: no files", { exitCode: EXIT.usage });

  const title = opts.title ?? found?.manifest.title ?? basename(dir);
  // Offline metadata: the author is the profile name — pack must work with no network.
  const config = loadConfig();
  const author = config.current ?? Object.keys(config.profiles)[0] ?? "unknown";
  const now = new Date();
  const metadata: BlueprintMetadata = {
    title,
    description: opts.description ?? "",
    author: { type: "user", id: author, name: author },
    created: now,
    version: 1,
    lastUpdated: now,
    bindings: {}, // binding shapes are a post-MVP idea; archives from pack carry none
  };

  const out = opts.out ?? `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.gadget`;
  writeFileSync(resolve(cwd, out), packArchive(metadata, files));
  console.log(`packed ${files.size} file${files.size === 1 ? "" : "s"} into ${out}`);
}

// --- publish ----------------------------------------------------------------

export type PublishOptions = {
  profile?: string;
  archive?: string;
  update?: string;
  title?: string;
  description?: string;
};

export async function publish(opts: PublishOptions): Promise<void> {
  if (opts.archive) return publishArchive(opts.archive, opts);

  const project = requireLinkedProject(process.cwd());
  if (!project.state) {
    throw new CliError("no sync base yet", { hint: "run: gadget pull", exitCode: EXIT.usage });
  }

  using ctx = await openAuthed(opts.profile ?? project.manifest.profile);
  using overseer = await openWorkspace(ctx, project.manifest.workspace);
  const workpieces = await listWorkpieces(ctx.session, overseer);
  const summary = resolveGadget(workpieces, project.manifest.gadget);
  const root = filesRootOf(summary);

  // The server snapshots ITS committed code, not local files — so the tree must be
  // pushed (clean against the base) and the base must be current (nothing new remote).
  const base = docFiles(project.state.doc, root);
  const dirty = diffFiles(base, readLocalFiles(project.dir));
  if (dirty.length > 0) {
    throw new CliError("local changes are not pushed; the blueprint would miss them", {
      hint: "run: gadget push, then publish",
      exitCode: EXIT.conflict,
    });
  }
  const probe = new Y.Doc();
  Y.applyUpdateV2(probe, Y.encodeStateAsUpdateV2(project.state.doc));
  await fetchCode(ctx.session, overseer, probe, project.state.version);
  if (diffFiles(base, docFiles(probe, root)).length > 0) {
    throw new CliError("the remote moved past your base; the blueprint would surprise you", {
      hint: "run: gadget pull, review, then publish",
      exitCode: EXIT.conflict,
    });
  }

  if (opts.update) {
    await ctx.session.rpc(
      overseer.updateBlueprint(opts.update, {
        updateCode: true,
        ...(opts.title !== undefined && { title: opts.title }),
        ...(opts.description !== undefined && { description: opts.description }),
      }),
      "updateBlueprint()",
    );
    console.log(`updated blueprint: ${ctx.origin}/blueprint/${opts.update}`);
    return;
  }

  using gadget = await ctx.session.rpc(
    overseer.getGadget(project.manifest.gadget),
    "getGadget()",
  );
  const created = await ctx.session.rpc(
    gadget.createBlueprint(opts.title ?? project.manifest.title, opts.description ?? ""),
    "createBlueprint()",
  );
  console.log(`published blueprint v${created.version}: ${ctx.origin}/blueprint/${created.id}`);
}

async function publishArchive(path: string, opts: PublishOptions): Promise<void> {
  const bytes = readFileSync(resolve(process.cwd(), path));
  parseArchive(bytes); // fail locally before shipping anything

  using ctx = await openAuthed(opts.profile);
  const stream = new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
  const id = await ctx.session.rpc(ctx.authed.importBlueprint(stream), "importBlueprint()");
  console.log(`imported blueprint (new id every time): ${ctx.origin}/blueprint/${id}`);
}

// --- install / new --from ----------------------------------------------------

// A blueprint reference: a /blueprint/<id> URL, or a bare id resolved against `fallback`.
export function resolveBlueprintRef(
  ref: string,
  fallbackOrigin?: string,
): { origin: string; id: string } {
  if (/^https?:\/\//i.test(ref)) {
    const url = new URL(ref);
    const match = /^\/blueprint\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      throw new CliError(`not a blueprint URL: ${ref}`, {
        hint: "expected https://<instance>/blueprint/<id>",
        exitCode: EXIT.usage,
      });
    }
    return { origin: url.origin, id: match[1]! };
  }
  if (!fallbackOrigin) {
    throw new CliError(`a bare blueprint id needs an instance: ${ref}`, {
      hint: "pass the full https://<instance>/blueprint/<id> URL, or log in first",
      exitCode: EXIT.usage,
    });
  }
  return { origin: instanceOrigin(fallbackOrigin), id: ref };
}

export async function install(ref: string, opts: { profile?: string }): Promise<void> {
  const { name, profile } = resolveProfile(loadConfig(), opts.profile);
  const { origin, id } = resolveBlueprintRef(ref, profile.url);
  if (origin !== instanceOrigin(profile.url)) {
    throw new CliError(`this blueprint lives on ${origin}, but profile ${name} is for ${instanceOrigin(profile.url)}`, {
      hint: `run: gadget login ${origin} — or use gadget new --from <url> for a local copy`,
      exitCode: EXIT.usage,
    });
  }

  using ctx = await openAuthed(name);
  const info = await ctx.session.rpc(ctx.session.api.getBlueprint(id), "getBlueprint()");
  if (!info) throw new CliError(`blueprint not found: ${id}`, { exitCode: EXIT.usage });

  const bindings = Object.keys(info.metadata.bindings);
  if (bindings.length > 0) {
    throw new CliError(
      `this blueprint needs ${bindings.length} connection${bindings.length === 1 ? "" : "s"} (${bindings.join(", ")})`,
      {
        hint: `wiring connections needs the browser: ${origin}/blueprint/${id}`,
      },
    );
  }

  using overseer = (await ctx.session.rpc(
    ctx.authed.newGadgetFromBlueprint(id, {}),
    "newGadgetFromBlueprint()",
  )) as Awaited<ReturnType<typeof openWorkspace>>;
  const metadata = await ctx.session.rpc(overseer.getMetadata(), "getMetadata()");
  console.log(`created "${info.metadata.title}" from the blueprint`);
  console.log(`open: ${origin}/workspace/${metadata.id}`);
  console.log(`pull: gadget pull ${metadata.id}`);
}

// Materialize a blueprint (local .gadget file, or a blueprint URL/id) into `dir`.
export async function newFrom(source: string, dir: string, title?: string): Promise<void> {
  let bytes: Uint8Array;
  if (/^https?:\/\//i.test(source) === false && looksLikeFile(source)) {
    bytes = readFileSync(resolve(process.cwd(), source));
  } else {
    const fallback = currentProfileUrl();
    const { origin, id } = resolveBlueprintRef(source, fallback);
    using session = openSession(origin);
    // downloadBlueprint is unauthenticated by upstream design: a blueprint is just data.
    const stream = await session.rpc(session.api.downloadBlueprint(id), "downloadBlueprint()");
    bytes = await readAll(stream);
  }

  const { metadata, files } = parseArchive(bytes);
  if (loadManifest(dir) || readLocalFiles(dir).size > 0) {
    throw new CliError(`directory is not empty: ${dir}`, { exitCode: EXIT.usage });
  }
  materialize(dir, files, files.keys());
  saveManifest(dir, { title: title ?? metadata.title });
  console.log(`unpacked "${metadata.title}": ${[...files.keys()].sort().join(", ")}`);
  const bindings = Object.keys(metadata.bindings);
  if (bindings.length > 0) {
    console.log(`note: the blueprint declares connections (${bindings.join(", ")}); wire them in the workshop after push`);
  }
  console.log("next: gadget push --new");
}

function looksLikeFile(source: string): boolean {
  try {
    readFileSync(resolve(process.cwd(), source), { encoding: null });
    return true;
  } catch {
    return false;
  }
}

function currentProfileUrl(): string | undefined {
  try {
    return resolveProfile(loadConfig()).profile.url;
  } catch {
    return undefined;
  }
}

const MAX_ARCHIVE_BYTES = 24 + MAX_METADATA_BYTES + MAX_CONTENT_BYTES;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new CliError("archive download exceeds the format's size caps");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
