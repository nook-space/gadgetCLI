// Interactive input. Prompts write to stderr so stdout stays clean for data/--json.
// Non-interactive lanes (agents, CI): --username flag + GADGET_PASSWORD env, or piped stdin.

import { createInterface } from "node:readline/promises";
import { CliError, EXIT } from "../errors.js";

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// Password precedence: GADGET_PASSWORD env → masked TTY prompt → one line from piped stdin.
export async function readPassword(question: string): Promise<string> {
  const fromEnv = process.env["GADGET_PASSWORD"];
  if (fromEnv !== undefined) return fromEnv;
  if (!process.stdin.isTTY) {
    const line = await prompt("");
    if (!line) throw new CliError("no password on stdin", {
      hint: "set GADGET_PASSWORD or run interactively",
      exitCode: EXIT.usage,
    });
    return line;
  }
  return promptHidden(question);
}

function promptHidden(question: string): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") { // Ctrl-C in raw mode does not raise SIGINT; honor it by hand
          cleanup();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    stdin.on("data", onData);
  });
}
