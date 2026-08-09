#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { EXIT } from "../errors.js";
import { renderError } from "./render.js";
import { doctor } from "./commands/doctor.js";
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
