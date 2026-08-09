import { spawn } from "node:child_process";
import { loadConfig } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";
import { instanceOrigin } from "../../remote/session.js";
import { requireLinkedProject } from "../project.js";

export async function open(opts: { profile?: string }): Promise<void> {
  const project = requireLinkedProject(process.cwd());
  const profileName = opts.profile ?? project.manifest.profile;
  const profile = loadConfig().profiles[profileName];
  if (!profile) {
    throw new CliError(`no such profile: ${profileName}`, {
      hint: `run: gadget login <url> (this project expects profile ${profileName})`,
      exitCode: EXIT.auth,
    });
  }

  const url = `${instanceOrigin(profile.url)}/workspace/${project.manifest.workspace}`;
  console.log(url);

  // Best-effort convenience on macOS; the printed URL is the contract.
  if (process.platform === "darwin") {
    // The URL is printed; the browser is optional. The error listener matters:
    // spawn failures arrive as async events that would otherwise crash the process.
    const child = spawn("open", [url], { stdio: "ignore", detached: true });
    child.once("error", () => {});
    child.unref();
  }
}
