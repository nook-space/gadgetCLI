import { CliError, EXIT } from "../../errors.js";
import { diffFiles, unifiedDiff } from "../../sync/diff.js";
import { docFiles, readLocalFiles } from "../../sync/files.js";
import { requireLinkedProject, type LinkedProject } from "../project.js";
import { printJson } from "../render.js";

const KIND_MARK = { added: "A", modified: "M", deleted: "D" } as const;

function baseAndLocal(project: LinkedProject) {
  if (!project.state || project.manifest.root === undefined) {
    throw new CliError("no sync base yet", {
      hint: "run: gadget pull",
      exitCode: EXIT.usage,
    });
  }
  return {
    base: docFiles(project.state.doc, project.manifest.root),
    local: readLocalFiles(project.dir),
  };
}

export async function status(opts: { json?: boolean }): Promise<void> {
  const project = requireLinkedProject(process.cwd());
  const { base, local } = baseAndLocal(project);
  const changes = diffFiles(base, local);

  if (opts.json) {
    printJson({ workspace: project.manifest.workspace, gadget: project.manifest.gadget, changes });
    return;
  }
  if (changes.length === 0) {
    console.log("clean");
    return;
  }
  for (const change of changes) console.log(`${KIND_MARK[change.kind]} ${change.path}`);
}

export async function diff(): Promise<void> {
  const project = requireLinkedProject(process.cwd());
  const { base, local } = baseAndLocal(project);

  const parts: string[] = [];
  for (const change of diffFiles(base, local)) {
    parts.push(unifiedDiff(
      change.path,
      base.get(change.path) ?? "",
      local.get(change.path) ?? "",
    ));
  }
  if (parts.length === 0) {
    console.log("clean");
    return;
  }
  console.log(parts.join("\n"));
}
