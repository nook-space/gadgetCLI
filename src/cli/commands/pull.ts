import * as Y from "yjs";
import { loadConfig, resolveProfile } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";
import { openAuthed } from "../../remote/authed.js";
import { changedPaths } from "../../sync/diff.js";
import { docFiles, materialize, readLocalFiles } from "../../sync/files.js";
import {
  fetchCode, filesRootOf, listWorkpieces, openWorkspace, resolveGadget,
} from "../../sync/engine.js";
import { findProject, loadState, saveManifest, saveState } from "../../sync/state.js";

export type PullOptions = { profile?: string; gadget?: string; force?: boolean };

export async function pull(idArg: string | undefined, opts: PullOptions): Promise<void> {
  const cwd = process.cwd();
  const found = findProject(cwd);

  // Which workspace, and where on disk. An id argument links the current directory;
  // without one the directory must already be linked.
  let dir: string;
  let workspaceId: string;
  let manifest = found?.manifest;
  if (idArg) {
    if (manifest?.workspace && manifest.workspace !== idArg) {
      throw new CliError(`this directory is linked to workspace ${manifest.workspace}`, {
        hint: "pull a different workspace in a different directory",
        exitCode: EXIT.usage,
      });
    }
    dir = found?.dir ?? cwd;
    workspaceId = idArg;
  } else {
    if (!found || !manifest?.workspace) {
      throw new CliError("not a linked gadget project", {
        hint: "run: gadget pull <workspace-id> (see gadget list)",
        exitCode: EXIT.usage,
      });
    }
    dir = found.dir;
    workspaceId = manifest.workspace;
  }

  const profileName =
    opts.profile ?? manifest?.profile ?? resolveProfile(loadConfig()).name;
  using ctx = await openAuthed(profileName);
  using overseer = await openWorkspace(ctx, workspaceId);

  const workpieces = await listWorkpieces(ctx.session, overseer);
  const wanted = opts.gadget !== undefined ? Number(opts.gadget) : manifest?.gadget;
  const summary = resolveGadget(workpieces, wanted);
  const root = filesRootOf(summary);

  // Snapshot the base's view of our root, then fast-forward the base doc.
  const state = loadState(dir);
  const doc = state?.doc ?? new Y.Doc();
  const baseFiles = docFiles(doc, root);
  const version = await fetchCode(ctx.session, overseer, doc, state?.version ?? 0);
  const remoteFiles = docFiles(doc, root);

  const remoteChanged = changedPaths(baseFiles, remoteFiles);
  const dirty = changedPaths(baseFiles, readLocalFiles(dir));
  const conflicts = [...remoteChanged].filter((p) => dirty.has(p)).sort();

  if (conflicts.length > 0 && !opts.force) {
    throw new CliError(`pull would overwrite local changes: ${conflicts.join(", ")}`, {
      hint: "commit or stash your work, then retry; --force overwrites these files",
      exitCode: EXIT.conflict,
    });
  }

  // Order matters: a base must never advance past files it did not materialize.
  // (No cross-file atomicity with the saves below: a crash here keeps the OLD base,
  // which is safe — the next pull redoes the work, at worst reporting a conflict
  // that --force re-pulls through.)
  materialize(dir, remoteFiles, remoteChanged);
  saveManifest(dir, {
    title: summary.title,
    profile: profileName,
    workspace: workspaceId,
    gadget: summary.id,
    root,
  });
  saveState(dir, version, doc);

  console.log(
    remoteChanged.size === 0
      ? `already up to date (version ${version})`
      : `pulled ${remoteChanged.size} file${remoteChanged.size === 1 ? "" : "s"} at version ${version}`,
  );
}
