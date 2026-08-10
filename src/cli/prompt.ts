// Interactive input. Prompts write to stderr so stdout stays clean for data/--json.
// Non-interactive lanes (agents, CI): --username flag + GADGET_PASSWORD env, or piped stdin.
//
// Piped stdin uses ONE shared readline for the whole process: a fresh interface per
// question would discard lines the previous one already buffered. EOF resolves "" so
// empty-input guards fire instead of hanging. main.ts calls closePrompts() at exit.

import type { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline/promises";
import { CliError, EXIT } from "../errors.js";

let shared: Interface | undefined;
let sharedClosed = false;
// Lines the pipe delivered before anyone asked for them. readline emits a buffered
// line the moment it arrives; without this queue, a fast pipe's second line lands
// between two questions and is silently lost.
const pendingLines: string[] = [];
let waiter: ((line: string | undefined) => void) | undefined;

function sharedIface(): Interface {
  if (!shared) {
    shared = createInterface({ input: process.stdin });
    shared.on("line", (line) => {
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(line);
      } else {
        pendingLines.push(line);
      }
    });
    shared.on("close", () => {
      sharedClosed = true;
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(undefined);
      }
    });
  }
  return shared;
}

export function closePrompts(): void {
  shared?.close();
}

// One line of input, untrimmed. TTY: fresh interface per question (no buffering risk).
// Piped: the queue-backed shared interface; EOF yields "" so empty-input guards fire.
async function ask(question: string): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
  if (question) process.stderr.write(question);
  sharedIface();
  if (pendingLines.length > 0) return pendingLines.shift()!;
  if (sharedClosed) return "";
  const line = await new Promise<string | undefined>((resolve) => {
    waiter = resolve;
  });
  return line ?? "";
}

export async function prompt(question: string): Promise<string> {
  return (await ask(question)).trim();
}

// Password precedence: GADGET_PASSWORD env → masked TTY prompt → one line from piped stdin.
// Passwords are never trimmed — whitespace is part of the secret; only the line
// terminator is gone (readline strips it).
export async function readPassword(question: string): Promise<string> {
  const fromEnv = process.env["GADGET_PASSWORD"];
  if (fromEnv !== undefined) {
    if (fromEnv === "") {
      throw new CliError("GADGET_PASSWORD is set but empty", {
        hint: "set a real password, or unset it to be prompted",
        exitCode: EXIT.usage,
      });
    }
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    const line = await ask("");
    if (!line) {
      throw new CliError("no password on stdin", {
        hint: "set GADGET_PASSWORD or run interactively",
        exitCode: EXIT.usage,
      });
    }
    return line;
  }
  const password = await promptHidden(question, process.stdin);
  if (!password) {
    throw new CliError("empty password", { exitCode: EXIT.usage });
  }
  return password;
}

// The slice of a TTY stream promptHidden needs; a test fake is an EventEmitter with these.
export type RawInput = EventEmitter & {
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
};

// Masked input on a raw-mode TTY. Ignores terminal control input: ESC-initiated CSI/SS3
// sequences (arrow keys would otherwise inject invisible bytes) and other C0 controls.
// Backspace removes one code point, not one UTF-16 unit, so astral chars delete cleanly.
export function promptHidden(question: string, input: RawInput): Promise<string> {
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve) => {
    let value = "";
    // Escape-sequence state: "esc" right after ESC; "csi" inside a multi-byte
    // ESC[/ESC O sequence, which ends on its final byte (0x40-0x7e, e.g. the D in ESC[D).
    let escape: "" | "esc" | "csi" = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (escape === "esc") {
          escape = ch === "[" || ch === "O" ? "csi" : "";
          continue;
        }
        if (escape === "csi") {
          if (ch >= "@" && ch <= "~") escape = "";
          continue;
        }
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
        if (ch === "\u001b") escape = "esc";
        else if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        else if (ch >= " ") value += ch; // drop remaining C0 controls
      }
    };
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
    };
    input.on("data", onData);
  });
}
