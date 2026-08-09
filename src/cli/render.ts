// All user-facing output goes through here: aligned key/value lines for humans,
// one JSON object on stdout for --json, and exactly one rendering of any error.

import { CliError, EXIT } from "../errors.js";

export function printKv(rows: [string, string][]): void {
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) console.log(`${key.padEnd(width)}  ${value}`);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

// True when the failure smells like the instance speaking a newer API than this CLI.
function looksLikeApiDrift(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause as Error | undefined) {
    if (/no such method|is not a function|unknown method/i.test(e.message)) return true;
  }
  return false;
}

export function renderError(err: unknown): number {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    if (err.cause instanceof Error && err.cause.message) {
      console.error(`cause: ${err.cause.message}`);
    }
    if (err.hint) console.error(`hint: ${err.hint}`);
    else if (looksLikeApiDrift(err)) {
      console.error("hint: the instance API may be newer than this CLI; update gadget-cli");
    }
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`error: ${message}`);
  if (looksLikeApiDrift(err)) {
    console.error("hint: the instance API may be newer than this CLI; update gadget-cli");
    return EXIT.rpc;
  }
  return EXIT.error;
}
