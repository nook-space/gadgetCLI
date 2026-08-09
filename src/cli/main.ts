#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { EXIT } from "../errors.js";
import { renderError } from "./render.js";
import { doctor } from "./commands/doctor.js";
import { login } from "./commands/login.js";
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
}
