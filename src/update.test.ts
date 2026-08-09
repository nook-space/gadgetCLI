import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  detectInstallMethod, isNewer, noticeAndSchedule, runnableUpdateCommand, updateAdvice,
  updateCachePath,
} from "./update.js";

describe("isNewer", () => {
  test("compares releases numerically, not lexically", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true); // the classic string-compare trap
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
  });

  test("equal or older never notifies", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
  });

  test("prereleases and junk never notify", () => {
    expect(isNewer("0.2.0-beta.1", "0.1.0")).toBe(false);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
    expect(isNewer("0.2", "0.1.0")).toBe(false);
  });
});

describe("detectInstallMethod", () => {
  test("recognizes npx, homebrew, a global install, and a source checkout", () => {
    expect(detectInstallMethod("/Users/x/.npm/_npx/abc123/node_modules/gadget-cli/dist/update.js"))
      .toBe("npx");
    expect(detectInstallMethod("/opt/homebrew/Cellar/gadget-cli/0.1.0/libexec/dist/update.js"))
      .toBe("homebrew");
    expect(detectInstallMethod("/usr/local/lib/node_modules/gadget-cli/dist/update.js"))
      .toBe("npm-global");
    expect(detectInstallMethod("/Users/x/code/gadgetCLI/dist/update.js")).toBe("source");
  });
});

describe("update advice", () => {
  test("every install method gets an actionable next step", () => {
    expect(updateAdvice("npm-global")).toContain("gadget update");
    expect(updateAdvice("homebrew")).toMatch(/^brew upgrade /);
    expect(updateAdvice("npx")).toContain("@latest");
    expect(updateAdvice("source")).toContain("git pull");
  });

  test("only a global npm install is safe to run for the user", () => {
    expect(runnableUpdateCommand("npm-global")).toMatch(/^npm install -g /);
    for (const method of ["homebrew", "npx", "source"] as const) {
      expect(runnableUpdateCommand(method), method).toBeUndefined();
    }
  });
});

describe("noticeAndSchedule", () => {
  let dir: string;
  let written: string[];
  let wasTTY: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gadget-notice-"));
    process.env["XDG_CONFIG_HOME"] = dir;
    delete process.env["CI"]; // vitest may set it; these tests own the suppression inputs
    delete process.env["GADGET_NO_UPDATE_CHECK"];
    delete process.env["NO_UPDATE_NOTIFIER"];
    // A fresh cache claiming a newer release: present for the notice, recent enough
    // that no background check is spawned.
    mkdirSync(join(dir, "gadget"), { recursive: true });
    writeFileSync(
      updateCachePath(),
      JSON.stringify({ checkedAt: new Date().toISOString(), latest: "99.0.0" }),
    );
    written = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    // isTTY is a plain property (absent when piped), not a getter — set and restore it.
    wasTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    delete process.env["XDG_CONFIG_HOME"];
    process.stdout.isTTY = wasTTY;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("tells a human at a terminal, naming the version and the update verb", () => {
    noticeAndSchedule({});
    const text = written.join("");
    expect(text).toContain("99.0.0");
    expect(text).toContain("update:"); // the advice itself varies by install method
  });

  test("reports stale skill copies with the refresh command", () => {
    noticeAndSchedule({ skillStale: ["/somewhere/SKILL.md"] });
    expect(written.join("")).toContain("gadget skill refresh");
  });

  test("--json, CI, and the opt-out env vars all silence it", () => {
    noticeAndSchedule({ json: true });
    expect(written.join("")).toBe("");

    for (const name of ["CI", "GADGET_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER"]) {
      written.length = 0;
      process.env[name] = "1";
      noticeAndSchedule({ skillStale: ["/somewhere/SKILL.md"] });
      expect(written.join(""), name).toBe("");
      delete process.env[name];
    }
  });
});
