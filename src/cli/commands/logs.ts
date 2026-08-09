import { RpcStub, RpcTarget } from "capnweb";
import { openAuthed } from "../../remote/authed.js";
import { setSigintExitCode } from "../../remote/session.js";
import type { ConsoleLogEvent } from "../../remote/types.js";
import { openWorkspace } from "../../sync/engine.js";
import { requireLinkedProject } from "../project.js";

// Live-only by upstream design: the server stores no logs, so this is follow mode.
// The stream is workspace-wide (all gadgets in the workspace).
export async function logs(opts: { profile?: string }): Promise<void> {
  const project = requireLinkedProject(process.cwd());
  using ctx = await openAuthed(opts.profile ?? project.manifest.profile);
  using overseer = await openWorkspace(ctx, project.manifest.workspace);

  class Subscriber extends RpcTarget {
    async event(chatId: number | null, entries: ConsoleLogEvent[]) {
      for (const entry of entries) {
        const time = entry.timestamp.toISOString().slice(11, 19);
        const chat = chatId === null ? "" : `  (chat ${chatId})`;
        console.log(`${time} ${entry.level.padEnd(5)} ${entry.message.map(show).join(" ")}${chat}`);
      }
    }
  }

  using subscriber = new RpcStub(new Subscriber());
  using _sub = await ctx.session.rpc(
    overseer.subscribeToConsoleLogs(subscriber as never),
    "subscribeToConsoleLogs()",
  );

  console.error(`streaming live logs for workspace ${project.manifest.workspace} (Ctrl-C to stop)`);
  setSigintExitCode(0); // stopping a log stream is success, not a failure
  await new Promise(() => {}); // stream until SIGINT closes the session
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
