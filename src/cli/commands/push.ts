import { basename } from "node:path";
import * as Y from "yjs";
import { CliError, EXIT } from "../../errors.js";
import { openAuthed, type AuthedContext } from "../../remote/authed.js";
import type { Overseer } from "../../remote/types.js";
import type { RpcStub } from "capnweb";
import { diffFiles } from "../../sync/diff.js";
import { docFiles, readLocalFiles } from "../../sync/files.js";
import {
  buildUpdate, fetchCode, filesRootOf, listWorkpieces, openWorkspace, resolveGadget,
} from "../../sync/engine.js";
import { findProject, saveManifest, saveState } from "../../sync/state.js";
import { requireLinkedProject } from "../project.js";

// One push is one WebSocket message; keep it far under transport limits.
const MAX_PUSH_BYTES = 10 * 1024 * 1024;

export type PushOptions = { profile?: string; new?: boolean; force?: boolean; title?: string };

export async function push(opts: PushOptions): Promise<void> {
  if (opts.title !== undefined && opts.title.trim() === "") {
    throw new CliError("--title must not be empty", { exitCode: EXIT.usage });
  }
  if (opts.new) return pushNew(opts);

  const project = requireLinkedProject(process.cwd());
  if (!project.state) {
    throw new CliError("no sync base yet", { hint: "run: gadget pull", exitCode: EXIT.usage });
  }

  using ctx = await openAuthed(opts.profile ?? project.manifest.profile);
  using overseer = await openWorkspace(ctx, project.manifest.workspace);
  const workpieces = await listWorkpieces(ctx.session, overseer);
  const summary = resolveGadget(workpieces, project.manifest.gadget);
  const root = filesRootOf(summary);

  // Freshness: snapshot the base's view of our root, fast-forward, and refuse iff a
  // tracked file's remote text moved past the base AND differs from the local text —
  // identical content is convergence, not a conflict (crash windows self-heal).
  // Never key off update presence: updates span other workpieces.
  const doc = project.state.doc;
  const baseFiles = docFiles(doc, root);
  const version = await fetchCode(ctx.session, overseer, doc, project.state.version);
  const remoteFiles = docFiles(doc, root);
  const localFiles = readLocalFiles(project.dir);
  checkPushSize(localFiles);

  const conflicts = diffFiles(baseFiles, remoteFiles)
    .map((c) => c.path)
    .filter((p) => remoteFiles.get(p) !== localFiles.get(p))
    .sort();
  if (conflicts.length > 0 && !opts.force) {
    throw new CliError(`the remote changed while you worked: ${conflicts.join(", ")}`, {
      hint: "run gadget pull, resolve, then push; --force pushes over the remote changes",
      exitCode: EXIT.conflict,
    });
  }

  const changes = diffFiles(remoteFiles, localFiles);
  const update = buildUpdate(doc, root, localFiles);
  if (!update) {
    saveState(project.dir, version, doc);
    console.log(`nothing to push (version ${version})`);
    return;
  }
  // The doc now holds the local content. Snapshot it before the resync: if a foreign
  // edit lands inside the push window, the base must NOT advance past content that was
  // never materialized — the next push has to refuse until a real pull happens.
  const prePushVersion = version;
  const preResync = Y.encodeStateAsUpdateV2(doc);
  await ctx.session.rpc(overseer.updateCode(update), "updateCode()");
  await testHoldAfterPush();

  const finalVersion = await fetchCode(ctx.session, overseer, doc, version);
  const drifted = diffFiles(localFiles, docFiles(doc, root)).map((c) => c.path).sort();
  if (drifted.length > 0) {
    console.error(
      `warning: the remote changed during the push (${drifted.join(", ")}); run gadget pull`,
    );
    const preDoc = new Y.Doc();
    Y.applyUpdateV2(preDoc, preResync);
    saveState(project.dir, prePushVersion, preDoc);
  } else {
    saveState(project.dir, finalVersion, doc);
  }
  console.log(`${describeChanges(changes)} at version ${finalVersion}`);
}

async function pushNew(opts: PushOptions): Promise<void> {
  const cwd = process.cwd();
  const found = findProject(cwd);
  if (found?.manifest.workspace) {
    throw new CliError(`this directory is already linked to workspace ${found.manifest.workspace}`, {
      hint: "run gadget push (without --new)",
      exitCode: EXIT.usage,
    });
  }
  const dir = found?.dir ?? cwd;
  const localFiles = readLocalFiles(dir);
  if (localFiles.size === 0) {
    throw new CliError("nothing to push: the project has no files", {
      hint: "run: gadget new <dir> first",
      exitCode: EXIT.usage,
    });
  }
  checkPushSize(localFiles);
  const title = opts.title ?? found?.manifest.title ?? basename(dir);

  using ctx = await openAuthed(opts.profile);
  const { overseer, workspaceId, gadgetId, root } = await createWorkspace(ctx, title);
  using _overseer = overseer;

  // Link the directory the moment the workspace exists: any later failure leaves a
  // linked project that plain pull + push recovers, never an unfindable workspace or
  // a duplicate on retry. (Before the first update lands, the workspace is provisional
  // and hidden from listings — the link is the only handle to it.)
  saveManifest(dir, {
    ...found?.manifest, title, profile: ctx.profileName,
    workspace: workspaceId, gadget: gadgetId, root,
  });
  console.log(`created workspace ${workspaceId} ("${title}")`);

  const doc = new Y.Doc();
  const version = await fetchCode(ctx.session, overseer, doc, 0);
  const update = buildUpdate(doc, root, localFiles);
  if (update) await ctx.session.rpc(overseer.updateCode(update), "updateCode()");
  const finalVersion = await fetchCode(ctx.session, overseer, doc, version);
  saveState(dir, finalVersion, doc);

  console.log(`pushed ${localFiles.size} file${localFiles.size === 1 ? "" : "s"} at version ${finalVersion}`);
  console.log(`open: ${ctx.origin}/workspace/${workspaceId}`);
}

async function createWorkspace(ctx: AuthedContext, title: string): Promise<{
  overseer: RpcStub<Overseer>;
  workspaceId: string;
  gadgetId: number;
  root: string;
}> {
  const overseer = (await ctx.session.rpc(
    ctx.authed.newGadget(),
    "newGadget()",
  )) as unknown as RpcStub<Overseer>;
  try {
    await ctx.session.rpc(overseer.setTitle(title), "setTitle()");
    // createGadget may consult the deployment's quick model for a binding name; give
    // it the sync deadline, not the default call deadline.
    using gadget = await ctx.session.rpc(overseer.createGadget(title), "createGadget()", 60_000);
    const gadgetId = await ctx.session.rpc(gadget.getId(), "getId()");
    const workpieces = await listWorkpieces(ctx.session, overseer);
    const summary = resolveGadget(workpieces, gadgetId);
    const metadata = await ctx.session.rpc(overseer.getMetadata(), "getMetadata()");
    return { overseer, workspaceId: metadata.id, gadgetId, root: filesRootOf(summary) };
  } catch (err) {
    overseer[Symbol.dispose]();
    throw err;
  }
}

function checkPushSize(files: Map<string, string>): void {
  let total = 0;
  for (const content of files.values()) total += Buffer.byteLength(content);
  if (total > MAX_PUSH_BYTES) {
    throw new CliError(`project is too large to push (${Math.round(total / 1024 / 1024)} MiB > 10 MiB)`, {
      hint: "gadgets are small apps; move data out of the code tree",
    });
  }
}

function describeChanges(changes: ReturnType<typeof diffFiles>): string {
  const written = changes.filter((c) => c.kind !== "deleted").length;
  const deleted = changes.length - written;
  const parts: string[] = [];
  if (written > 0) parts.push(`pushed ${written} file${written === 1 ? "" : "s"}`);
  if (deleted > 0) parts.push(`deleted ${deleted} file${deleted === 1 ? "" : "s"}`);
  return parts.join(", ") || "pushed 0 files";
}

// Test seam: hold between updateCode and the resync so a live test can land a foreign
// edit inside the push window deterministically. No-op unless the env var is set.
export async function testHoldAfterPush(): Promise<void> {
  const hold = process.env["GADGET_TEST_HOLD_AFTER_PUSH"];
  if (hold) await new Promise((r) => setTimeout(r, Number(hold)));
}
