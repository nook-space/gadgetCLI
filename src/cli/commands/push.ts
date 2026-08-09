import { basename } from "node:path";
import * as Y from "yjs";
import { CliError, EXIT } from "../../errors.js";
import { openAuthed, type AuthedContext } from "../../remote/authed.js";
import type { Overseer } from "../../remote/types.js";
import type { RpcStub } from "capnweb";
import { changedPaths, diffFiles } from "../../sync/diff.js";
import { docFiles, readLocalFiles } from "../../sync/files.js";
import {
  buildUpdate, fetchCode, filesRootOf, listWorkpieces, openWorkspace, resolveGadget,
} from "../../sync/engine.js";
import { findProject, saveManifest, saveState } from "../../sync/state.js";
import { requireLinkedProject } from "../project.js";

export type PushOptions = { profile?: string; new?: boolean; force?: boolean; title?: string };

export async function push(opts: PushOptions): Promise<void> {
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

  // Freshness: snapshot the base's view of our root, fast-forward, and refuse iff any
  // tracked file's text changed — never off update presence (updates span other roots).
  const doc = project.state.doc;
  const baseFiles = docFiles(doc, root);
  const version = await fetchCode(ctx.session, overseer, doc, project.state.version);
  const remoteFiles = docFiles(doc, root);
  const remoteChanged = [...changedPaths(baseFiles, remoteFiles)].sort();

  if (remoteChanged.length > 0 && !opts.force) {
    throw new CliError(`the remote changed while you worked: ${remoteChanged.join(", ")}`, {
      hint: "run gadget pull, resolve, then push; --force pushes over the remote changes",
      exitCode: EXIT.conflict,
    });
  }

  const localFiles = readLocalFiles(project.dir);
  const pushing = diffFiles(remoteFiles, localFiles).length;
  const update = buildUpdate(doc, root, localFiles);
  if (!update) {
    saveState(project.dir, version, doc);
    console.log(`nothing to push (version ${version})`);
    return;
  }
  await ctx.session.rpc(overseer.updateCode(update), "updateCode()");

  // Resync so state records server versions; if our root no longer matches what we
  // pushed, a foreign edit landed inside the push window (last-writer-wins races).
  const finalVersion = await fetchCode(ctx.session, overseer, doc, version);
  const drifted = [...changedPaths(localFiles, docFiles(doc, root))].sort();
  if (drifted.length > 0) {
    console.error(`warning: the remote changed during the push (${drifted.join(", ")}); run gadget pull`);
  }
  saveState(project.dir, finalVersion, doc);
  console.log(`pushed ${pushing} file${pushing === 1 ? "" : "s"} at version ${finalVersion}`);
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
  const title = opts.title ?? found?.manifest.title ?? basename(dir);

  using ctx = await openAuthed(opts.profile);
  const { overseer, workspaceId, gadgetId, root } = await createWorkspace(ctx, title);
  using _overseer = overseer;

  const doc = new Y.Doc();
  const version = await fetchCode(ctx.session, overseer, doc, 0);
  const update = buildUpdate(doc, root, localFiles);
  if (update) await ctx.session.rpc(overseer.updateCode(update), "updateCode()");
  const finalVersion = await fetchCode(ctx.session, overseer, doc, version);

  saveManifest(dir, { title, profile: ctx.profileName, workspace: workspaceId, gadget: gadgetId, root });
  saveState(dir, finalVersion, doc);

  console.log(`created workspace ${workspaceId} ("${title}")`);
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
    using gadget = await ctx.session.rpc(overseer.createGadget(title), "createGadget()");
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
