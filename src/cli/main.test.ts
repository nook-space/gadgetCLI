// Spawn tests against the built CLI (dist/) — `pnpm test` builds first.

import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");

function gadget(...args: string[]) {
  return run(process.execPath, [BIN, ...args], { env: { ...process.env } }).then(
    (r) => ({ ...r, code: 0 }),
    (err: Error & { code?: number; stdout: string; stderr: string }) =>
      ({ stdout: err.stdout, stderr: err.stderr, code: err.code ?? 1 }),
  );
}

describe("cli frame", () => {
  test("--version prints the version and exits 0", async () => {
    const r = await gadget("--version");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("unknown commands exit 2 with a hint", async () => {
    const r = await gadget("nosuchcmd");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
    expect(r.stderr).toContain("hint: run: gadget --help");
  });

  test("an unreachable instance exits 5 (rpc)", async () => {
    const r = await gadget("doctor", "localhost:1");
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("cannot reach the workshop api");
  }, 45_000);

  test("SIGINT with an open session exits 130", async () => {
    // Open a session to a dead port (connection is async; the session object exists at once)
    // and hold the process alive; SIGINT must close sessions and exit 130.
    const script = `
      const { openSession } = await import(${JSON.stringify("file://" + join(ROOT, "dist", "remote", "session.js"))});
      openSession("localhost:1");
      process.send?.("ready");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const stderr: string[] = [];
    child.stderr!.on("data", (d) => stderr.push(String(d)));
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("exit", (code) => reject(new Error(`exited early: ${code}\n${stderr.join("")}`)));
    });
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(130);
  });
});
