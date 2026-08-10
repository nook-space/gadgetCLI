import { afterEach, describe, expect, test, vi } from "vitest";
import { CliError, EXIT } from "../errors.js";
import { renderError } from "./render.js";

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => lines.push(line));
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("renderError", () => {
  test("CliError renders message, cause, hint, and its exit code", () => {
    const lines = capture();
    const code = renderError(
      new CliError("cannot reach x", {
        cause: new Error("socket closed"),
        hint: "check the URL",
        exitCode: EXIT.rpc,
      }),
    );
    expect(lines).toEqual(["error: cannot reach x", "cause: socket closed", "hint: check the URL"]);
    expect(code).toBe(EXIT.rpc);
  });

  test("plain errors render one line and exit 1", () => {
    const lines = capture();
    expect(renderError(new Error("boom"))).toBe(EXIT.error);
    expect(lines).toEqual(["error: boom"]);
  });

  test("api drift is detected through the cause chain", () => {
    const lines = capture();
    const wrapped = new CliError("listGadgets failed", {
      cause: new Error('RPC error: no such method "listGadgets2"'),
    });
    renderError(wrapped);
    expect(lines.at(-1)).toContain("update gadget-cli");
  });
});
