import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { promptHidden, readPassword, type RawInput } from "./prompt.js";

class FakeTty extends EventEmitter {
  rawModes: boolean[] = [];
  paused = false;
  setRawMode(mode: boolean) {
    this.rawModes.push(mode);
  }
  resume() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  setEncoding() {}
}

async function drive(...chunks: string[]): Promise<{ value: string; tty: FakeTty }> {
  const tty = new FakeTty();
  const pending = promptHidden("password: ", tty as RawInput);
  for (const chunk of chunks) tty.emit("data", chunk);
  return { value: await pending, tty };
}

afterEach(() => vi.restoreAllMocks());

describe("promptHidden", () => {
  test("collects chars until Enter, restores raw mode, removes listeners", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { value, tty } = await drive("se", "cret", "\r");
    expect(value).toBe("secret");
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.paused).toBe(true);
    expect(tty.listenerCount("data")).toBe(0);
  });

  test("a paste containing a newline submits at the newline", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { value } = await drive("abc\ndef");
    expect(value).toBe("abc");
  });

  test("backspace removes one code point, astral chars included", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { value } = await drive("a\u{1f49c}", "\u007f", "b\r");
    expect(value).toBe("ab");
  });

  test("arrow keys (CSI sequences) and C0 controls are ignored", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { value } = await drive("a", "\u001b[C", "b", "\u0007", "\r");
    expect(value).toBe("ab");
  });
});

describe("readPassword env lane", () => {
  test("a set-but-empty GADGET_PASSWORD is a usage error, not a password", async () => {
    vi.stubEnv("GADGET_PASSWORD", "");
    await expect(readPassword("password: ")).rejects.toThrow(/set but empty/);
  });

  test("the env value is used verbatim — no trimming", async () => {
    vi.stubEnv("GADGET_PASSWORD", " spacey pw ");
    await expect(readPassword("password: ")).resolves.toBe(" spacey pw ");
  });
});
