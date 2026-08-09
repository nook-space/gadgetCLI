import { describe, expect, test, vi } from "vitest";
import { CliError } from "../../errors.js";
import type { AuthVendorInfo } from "../../remote/types.js";
import { oauthLogin, pickVendor } from "./login.js";

const github: AuthVendorInfo = { vendorId: "github", displayName: "GitHub" };
const google: AuthVendorInfo = { vendorId: "google", displayName: "Google" };

describe("pickVendor", () => {
  test("explicit vendor must be offered", () => {
    expect(pickVendor([github, google], "google")).toBe(google);
    expect(() => pickVendor([github], "gitlab")).toThrow(/does not offer/);
    expect(() => pickVendor([], "github")).toThrow(
      expect.objectContaining({ hint: expect.stringContaining("password sign-in only") }),
    );
  });

  test("a sole vendor is chosen; several need --vendor; none explains itself", () => {
    expect(pickVendor([github])).toBe(github);
    expect(() => pickVendor([github, google])).toThrow(
      expect.objectContaining({ hint: expect.stringContaining("pass --vendor") }),
    );
    expect(() => pickVendor([])).toThrow(CliError);
  });
});

describe("oauthLogin", () => {
  test("prints the URL, awaits the attempt, disposes it, returns the token", async () => {
    const disposed: string[] = [];
    const attempt = {
      wait: async () => "user@x:secret",
      [Symbol.dispose]: () => void disposed.push("attempt"),
    };
    const session = {
      api: { startGatekeeperLogin: async () => ({ url: "https://idp.example/authorize", attempt }) },
      rpc: <T>(p: Promise<T>) => p,
    };
    const errLines = vi.spyOn(console, "error").mockImplementation(() => {});

    const token = await oauthLogin(
      session as never,
      { authVendors: [github] },
      undefined,
    );

    expect(token).toBe("user@x:secret");
    expect(disposed).toEqual(["attempt"]);
    expect(errLines.mock.calls.flat().join("\n")).toContain("https://idp.example/authorize");
    errLines.mockRestore();
  });
});
