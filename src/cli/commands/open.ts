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

  // Best-effort browser launch: macOS `open`, Linux `xdg-open`. The printed URL is the
  // contract — only a human at an interactive terminal gets a browser, never tests,
  // scripts, or agents (captured stdout).
  const opener = process.platform === "darwin" ? "open"
    : process.platform === "linux" ? "xdg-open"
    : undefined;
  if (opener && process.stdout.isTTY) {
    // The error listener matters: a missing opener binary arrives as an async event
    // that would otherwise crash the process after the URL is already printed.
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.once("error", () => {});
    child.unref();
  }
}
