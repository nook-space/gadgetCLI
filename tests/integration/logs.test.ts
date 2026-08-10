// Integration: gadget logs — live stream of gadget console output, Ctrl-C exits 0.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { seedUser, seedWorkspace, wakeGadget } from "./seed.js";

const INSTANCE = process.env["GADGET_TEST_URL"];
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const BIN = join(ROOT, "dist", "cli", "main.js");

const home = mkdtempSync(join(tmpdir(), "gadget-logs-"));
const work = mkdtempSync(join(tmpdir(), "gadget-logswork-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!INSTANCE)("logs against a live instance", () => {
  let token: string;
  let workspaceId: string;
  const dir = join(work, "noisy");

  beforeAll(async () => {
    ({ token } = await seedUser(INSTANCE!));
    mkdirSync(join(home, "gadget"), { recursive: true });
    writeFileSync(
      join(home, "gadget", "config.json"),
      JSON.stringify({ current: "t", profiles: { t: { url: INSTANCE, token } } }),
    );
    let gadgetIds: number[];
    ({ workspaceId, gadgetIds } = await seedWorkspace(INSTANCE!, token, "Noisy WS", [{
      title: "Noisy",
      files: {
        "server.js": [
          'import { DurableObject } from "cloudflare:workers";',
          "export class Gadget extends DurableObject {",
          '  async ping() { console.log("hello from the gadget"); return "pong"; }',
          "}",
          "",
        ].join("\n"),
        "client.js": "// none\n",
      },
    }]));
    // A linked project directory for the logs command to run in.
    mkdirSync(dir);
    writeFileSync(join(dir, "gadget.json"), JSON.stringify({
      title: "Noisy", profile: "t", workspace: workspaceId,
      gadget: gadgetIds[0], root: String(gadgetIds[0]),
    }));
  }, 60_000);

  test("streams a gadget's console.log and exits 0 on Ctrl-C", async () => {
    const child = spawn(process.execPath, [BIN, "logs"], {
      cwd: dir,
      env: { ...process.env, XDG_CONFIG_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on("data", (d) => out.push(String(d)));
    child.stderr.on("data", (d) => err.push(String(d)));

    // Wait for the subscription banner, then wake the gadget so it logs.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no banner: ${err.join("")}`)), 15_000);
      const check = () => {
        if (err.join("").includes("streaming live logs")) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
    await wakeGadget(INSTANCE!, token, workspaceId, "ping");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no log line: ${out.join("")}\n${err.join("")}`)), 15_000);
      const check = () => {
        if (out.join("").includes("hello from the gadget")) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    child.kill("SIGINT");
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/log\s+hello from the gadget/);
  }, 60_000);
});
