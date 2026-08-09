import { CliError, EXIT } from "../../errors.js";
import { openAuthed } from "../../remote/authed.js";
import { setSigintExitCode } from "../../remote/session.js";
import { openWorkspace, streamConsoleLogs } from "../../sync/engine.js";
import { requireLinkedProject } from "../project.js";
import { sanitize } from "../render.js";

// Live-only by upstream design: the server stores no logs, so this is follow mode.
// The stream is workspace-wide (all gadgets in the workspace).
export async function logs(opts: { profile?: string }): Promise<void> {
  const project = requireLinkedProject(process.cwd());
  using ctx = await openAuthed(opts.profile ?? project.manifest.profile);
  using overseer = await openWorkspace(ctx, project.manifest.workspace);

  using _sub = await streamConsoleLogs(ctx.session, overseer, (chatId, entries) => {
    for (const entry of entries) {
      const time = entry.timestamp.toISOString().slice(11, 19);
      const chat = chatId === null ? "" : `  (chat ${chatId})`;
      console.log(`${time} ${entry.level.padEnd(5)} ${sanitize(entry.message.map(show).join(" "))}${chat}`);
    }
  });

  console.error(`streaming live logs for workspace ${project.manifest.workspace} (Ctrl-C to stop)`);
  setSigintExitCode(0); // stopping a log stream is success, not a failure
  // Stream until SIGINT closes the session — or the transport dies, which must be an
  // error, not a silent exit 0 that looks like a healthy stop.
  await new Promise<never>((_, reject) => {
    ctx.session.onBroken((cause) =>
      reject(new CliError("connection to the instance lost", { cause, exitCode: EXIT.rpc })),
    );
  });
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
