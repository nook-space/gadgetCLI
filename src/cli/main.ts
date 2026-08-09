#!/usr/bin/env node
import { Command } from "commander";
import { renderError } from "./render.js";
import { doctor } from "./commands/doctor.js";
import { VERSION } from "../version.js";

const program = new Command("gadget")
  .version(VERSION)
  .description("Make and push gadgets to a self-hosted Cloudflare OS instance.")
  .option("--profile <name>", "profile to use (default: current)")
  .option("--json", "machine-readable output");

program
  .command("doctor")
  .argument("[url]", "instance URL (default: the profile's)")
  .description("check reachability, auth, and API health")
  .action((url: string | undefined) => doctor(url, program.opts()));

try {
  await program.parseAsync();
  process.exit(0);
} catch (err) {
  process.exit(renderError(err));
}
