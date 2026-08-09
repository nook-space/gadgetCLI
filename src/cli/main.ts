#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { EXIT } from "../errors.js";
import { renderError } from "./render.js";
import { closePrompts } from "./prompt.js";
import { install, pack, publish } from "./commands/blueprint.js";
import { doctor } from "./commands/doctor.js";
import { list } from "./commands/list.js";
import { logs } from "./commands/logs.js";
import { login } from "./commands/login.js";
import { newProject } from "./commands/new.js";
import { open } from "./commands/open.js";
import { pull } from "./commands/pull.js";
import { push } from "./commands/push.js";
import { installSkill, printSkill } from "./commands/skill.js";
import { diff, status } from "./commands/status.js";
import { whoami } from "./commands/whoami.js";
import { VERSION } from "../version.js";

const program = new Command("gadget")
  .version(VERSION)
  .description("Make and push gadgets to a self-hosted Cloudflare OS instance.")
  .option("--profile <name>", "profile to use (default: current)")
  .option("--json", "machine-readable output")
  .exitOverride();

program
  .command("doctor")
  .argument("[url]", "instance URL (default: the profile's)")
  .description("check reachability, auth, and API health")
  .action((url: string | undefined) => doctor(url, program.opts()));

program
  .command("login")
  .argument("<url>", "instance URL")
  .description("sign in and store the session token (non-interactive: --username + GADGET_PASSWORD)")
  .option("--create", "create a new account")
  .option("--username <name>", "username (password mode)")
  .option("--name <display>", "display name for --create (default: username)")
  .option("--vendor <id>", "sign in via an OAuth provider instead of a password")
  .action((url: string, cmdOpts: Record<string, string | boolean>) =>
    login(url, { ...program.opts(), ...cmdOpts }));

program
  .command("whoami")
  .description("print the signed-in identity")
  .action(() => whoami(program.opts()));

program
  .command("list")
  .description("list workspaces on the instance")
  .action(() => list(program.opts()));

program
  .command("pull")
  .argument("[workspace-id]", "workspace to pull (links this directory on first pull)")
  .description("download gadget code into the current directory")
  .option("--gadget <id>", "workpiece id, when the workspace has several gadgets")
  .option("--force", "overwrite conflicting local files")
  .action((id: string | undefined, cmdOpts: Record<string, string | boolean>) =>
    pull(id, { ...program.opts(), ...cmdOpts }));

program
  .command("status")
  .description("list local changes against the pulled base")
  .action(() => status(program.opts()));

program
  .command("diff")
  .description("show local changes against the pulled base")
  .action(() => diff());

program
  .command("push")
  .description("upload local changes as one CRDT update")
  .option("--new", "create a workspace and gadget for this project first")
  .option("--force", "push even when the remote changed (last writer wins)")
  .option("--title <title>", "workspace/gadget title for --new (default: directory name)")
  .action((cmdOpts: Record<string, string | boolean>) =>
    push({ ...program.opts(), ...cmdOpts }));

program
  .command("new")
  .argument("<dir>", "directory to scaffold")
  .description("scaffold a gadget project (server.js, client.js, README.md)")
  .option("--title <title>", "gadget title (default: directory name)")
  .option("--from <blueprint>", "start from a blueprint URL, id, or .gadget file")
  .action((dir: string, cmdOpts: Record<string, string>) =>
    newProject(dir, { ...program.opts(), ...cmdOpts }));

program
  .command("pack")
  .description("pack the project into a .gadget archive")
  .option("--out <file>", "output path (default: <title>.gadget)")
  .option("--title <title>", "blueprint title (default: the manifest's)")
  .option("--description <text>", "blueprint description")
  .action((cmdOpts: Record<string, string>) => pack({ ...program.opts(), ...cmdOpts }));

const blueprint = program.command("blueprint").description("publish and manage blueprints");
blueprint
  .command("publish")
  .description("publish this gadget as a blueprint (or import an archive)")
  .option("--update <id>", "update an existing blueprint to the pushed code")
  .option("--archive <file>", "import a .gadget archive instead (new id every time)")
  .option("--title <title>", "blueprint title")
  .option("--description <text>", "blueprint description")
  .action((cmdOpts: Record<string, string>) => publish({ ...program.opts(), ...cmdOpts }));

program
  .command("install")
  .argument("<blueprint>", "blueprint URL or id")
  .description("create an own gadget from a blueprint (zero-binding blueprints only)")
  .action((ref: string) => install(ref, program.opts()));

program
  .command("open")
  .description("print (and open) the workspace URL")
  .action(() => open(program.opts()));

program
  .command("logs")
  .description("stream the workspace's live console logs (Ctrl-C to stop)")
  .action(() => logs(program.opts()));

const skill = program
  .command("skill")
  .description("print the agent skill (teaches an agent to drive gadget) to stdout")
  .action(() => printSkill());
skill
  .command("install [target]")
  .description("install the skill for an agent (default target: claude-code)")
  .option("--path <path>", "install to this file or directory instead")
  .action((target: string | undefined, cmdOpts: { path?: string }) =>
    installSkill(target, cmdOpts));

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    // Commander already printed its own message (help, version, or the usage error).
    if (err.exitCode !== 0) {
      console.error("hint: run: gadget --help");
      process.exitCode = EXIT.usage;
    }
  } else {
    process.exitCode = renderError(err);
  }
} finally {
  closePrompts();
}
