import { openAuthed } from "../../remote/authed.js";
import { printJson, printKv } from "../render.js";

export async function whoami(opts: { profile?: string; json?: boolean }): Promise<void> {
  using ctx = await openAuthed(opts.profile);
  const me = await ctx.session.rpc(ctx.authed.whoami(), "whoami()");

  if (opts.json) {
    printJson({ name: me.name, id: me.id, instance: ctx.origin, profile: ctx.profileName });
    return;
  }
  printKv([
    ["name", me.name],
    ["id", me.id],
    ["instance", ctx.origin],
    ["profile", ctx.profileName],
  ]);
}
