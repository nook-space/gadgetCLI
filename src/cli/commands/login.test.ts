import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { describe, expect, test, vi } from "vitest";
import { CliError } from "../../errors.js";
import type { AuthVendorInfo, PublicApi, ServerConfig } from "../../remote/types.js";
import { oauthLogin, pickVendor, planLogin } from "./login.js";

const baseConfig: ServerConfig = {
  authVendors: [],
  passwordAuthEnabled: true,
  cloudflareLimitsEnabled: false,
  signupsEnabled: true,
  siteName: "",
  announcement: "",
};

describe("planLogin", () => {
  const origin = "https://os.acme.dev";

  test("password instance: plain login and --create both go password", () => {
    expect(planLogin(baseConfig, {}, origin)).toEqual({ mode: "password", create: false });
    expect(planLogin(baseConfig, { create: true }, origin)).toEqual({
      mode: "password",
      create: true,
    });
  });

  test("--vendor always routes to OAuth, even where password auth exists", () => {
    expect(planLogin(baseConfig, { vendor: "github" }, origin)).toEqual({ mode: "oauth" });
  });

  test("password-disabled instance routes to OAuth", () => {
    const oauthOnly = { ...baseConfig, passwordAuthEnabled: false,
      authVendors: [{ vendorId: "google", displayName: "Google" }] };
    expect(planLogin(oauthOnly, {}, origin)).toEqual({ mode: "oauth" });
  });

  test("--create on an OAuth instance is refused with the provider recipe, not silently ignored", () => {
    const oauthOnly = { ...baseConfig, passwordAuthEnabled: false,
      authVendors: [{ vendorId: "google", displayName: "Google" }] };
    expect(() => planLogin(oauthOnly, { create: true }, origin)).toThrow(
      expect.objectContaining({
        exitCode: 2,
        hint: expect.stringContaining("--vendor google"),
      }),
    );
  });

  test("--create where nothing gadget-cli supports exists (Access-style) explains that", () => {
    const noneSupported = { ...baseConfig, passwordAuthEnabled: false, authVendors: [] };
    expect(() => planLogin(noneSupported, { create: true }, origin)).toThrow(
      expect.objectContaining({ hint: expect.stringContaining("no password signup") }),
    );
  });
});

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

  // Regression (phase-1 critique blocker 2): disposing the attempt stub is upstream's
  // documented "abandon the sign-in" signal, so it must not happen until wait() settles.
  // This drives a REAL capnweb pair; a dispose-before-settle would reject with "abandoned".
  test("does not send the abandon signal while waiting (real rpc pair)", async () => {
    class FakeAttempt extends RpcTarget {
      #resolve?: (token: string) => void;
      #reject?: (err: Error) => void;
      wait(): Promise<string> {
        return new Promise((resolve, reject) => {
          this.#resolve = resolve;
          this.#reject = reject;
        });
      }
      complete(token: string) {
        this.#resolve?.(token);
      }
      [Symbol.dispose]() {
        this.#reject?.(new Error("sign-in abandoned"));
      }
    }
    class FakePublicApi extends RpcTarget {
      constructor(readonly attempt: FakeAttempt) {
        super();
      }
      async startGatekeeperLogin(_vendorId: string) {
        return { url: "https://idp.example/authorize", attempt: this.attempt };
      }
    }

    const { port1, port2 } = new MessageChannel();
    const attempt = new FakeAttempt();
    newMessagePortRpcSession(port1, new FakePublicApi(attempt));
    const api = newMessagePortRpcSession<PublicApi>(port2);
    const errLines = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const session = { api, rpc: <T>(p: Promise<T>) => p };
      const pending = oauthLogin(session as never, { authVendors: [github] }, undefined);
      // Let the using-scope exit and any release message travel the wire first;
      // the human completes the sign-in strictly afterwards.
      await new Promise((r) => setTimeout(r, 100));
      attempt.complete("user@x:secret");
      await expect(pending).resolves.toBe("user@x:secret");
    } finally {
      errLines.mockRestore();
      api[Symbol.dispose]();
      port1.close();
      port2.close();
    }
  });
});
