import { describe, expect, test } from "vitest";
import { CliError } from "../../errors.js";
import { resolveBlueprintRef } from "./blueprint.js";

describe("resolveBlueprintRef", () => {
  test("full URLs resolve, trailing slash tolerated, junk paths refused", () => {
    expect(resolveBlueprintRef("https://os.acme.dev/blueprint/abc123")).toEqual({
      origin: "https://os.acme.dev",
      id: "abc123",
    });
    expect(resolveBlueprintRef("http://localhost:8787/blueprint/format.document/").id)
      .toBe("format.document");
    expect(() => resolveBlueprintRef("https://os.acme.dev/workspace/x")).toThrow(/not a blueprint URL/);
    expect(() => resolveBlueprintRef("https://os.acme.dev/blueprint/a/b")).toThrow(CliError);
  });

  test("bare ids need a fallback origin", () => {
    expect(resolveBlueprintRef("abc123", "https://os.acme.dev")).toEqual({
      origin: "https://os.acme.dev",
      id: "abc123",
    });
    expect(resolveBlueprintRef("abc", "localhost:8787").origin).toBe("http://localhost:8787");
    expect(() => resolveBlueprintRef("abc123")).toThrow(/needs an instance/);
  });
});
