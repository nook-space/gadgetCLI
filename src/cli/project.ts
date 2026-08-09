// Command-side project context: locate the linked project and open its instance.

import { CliError, EXIT } from "../errors.js";
import { openAuthed, type AuthedContext } from "../remote/authed.js";
import { findProject, loadState, type Manifest, type ProjectState } from "../sync/state.js";

export type LinkedProject = {
  dir: string;
  manifest: Manifest & { profile: string; workspace: string; gadget: number };
  state?: ProjectState;
};

// The nearest project above cwd, required to be linked to a workspace.
export function requireLinkedProject(cwd: string): LinkedProject {
  const found = findProject(cwd);
  if (!found) {
    throw new CliError("not a gadget project", {
      hint: "run gadget new <dir>, or gadget pull <workspace-id> in an empty directory",
      exitCode: EXIT.usage,
    });
  }
  const { dir, manifest } = found;
  if (!manifest.profile || !manifest.workspace || manifest.gadget === undefined) {
    throw new CliError("this project is not linked to a workspace yet", {
      hint: "run: gadget push --new (create) or gadget pull <workspace-id> (link)",
      exitCode: EXIT.usage,
    });
  }
  return {
    dir,
    manifest: manifest as LinkedProject["manifest"],
    state: loadState(dir),
  };
}

// Open the instance a linked project belongs to. A --profile flag wins over the manifest.
export function openProjectInstance(
  project: LinkedProject,
  profileFlag?: string,
): Promise<AuthedContext> {
  return openAuthed(profileFlag ?? project.manifest.profile);
}
