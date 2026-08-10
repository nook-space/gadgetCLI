import { openAuthed } from "../../remote/authed.js";
import { printJson } from "../render.js";

export async function list(opts: { profile?: string; json?: boolean }): Promise<void> {
  using ctx = await openAuthed(opts.profile);
  const workspaces = await ctx.session.rpc(ctx.authed.listGadgets(), "listGadgets()");

  if (opts.json) {
    printJson(workspaces.map((w) => ({
      id: w.id,
      title: w.title,
      role: w.role ?? "build",
      owner: w.owner?.name,
      created: w.created.toISOString(),
      lastActive: w.lastActive.toISOString(),
    })));
    return;
  }
  if (workspaces.length === 0) {
    console.log("no workspaces yet (run: gadget push --new in a project)");
    return;
  }
  for (const w of workspaces) {
    const shared = w.owner ? `  (shared by ${w.owner.name})` : "";
    console.log(`${w.id}  ${w.lastActive.toISOString().slice(0, 10)}  ${w.title}${shared}`);
  }
}
