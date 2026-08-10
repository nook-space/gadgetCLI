import { describe, expect, test } from "vitest";
import { CliError } from "../errors.js";
import { apiUrl, instanceOrigin, withDeadline } from "./session.js";

describe("instanceOrigin", () => {
  test("bare host defaults to https", () => {
    expect(instanceOrigin("os.acme.dev")).toBe("https://os.acme.dev");
  });
  test("localhost forms default to http", () => {
    expect(instanceOrigin("localhost:8787")).toBe("http://localhost:8787");
    expect(instanceOrigin("127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(instanceOrigin("[::1]:8787")).toBe("http://[::1]:8787");
  });
  test("explicit schemes and trailing slash survive", () => {
    expect(instanceOrigin("http://os.acme.dev")).toBe("http://os.acme.dev");
    expect(instanceOrigin("https://os.acme.dev/")).toBe("https://os.acme.dev");
  });
  test("ws(s) is an alias for http(s)", () => {
    expect(instanceOrigin("ws://localhost:8787")).toBe("http://localhost:8787");
    expect(instanceOrigin("wss://os.acme.dev")).toBe("https://os.acme.dev");
  });
  test("paths, queries, credentials, and non-http schemes are rejected", () => {
    expect(() => instanceOrigin("https://os.acme.dev/workspace/abc")).toThrow(CliError);
    expect(() => instanceOrigin("https://os.acme.dev/?x=1")).toThrow(CliError);
    expect(() => instanceOrigin("https://user:pw@os.acme.dev")).toThrow(/credentials/);
    expect(() => instanceOrigin("ftp://os.acme.dev")).toThrow(CliError);
    expect(() => instanceOrigin("not a url")).toThrow(CliError);
  });
});

describe("apiUrl", () => {
  test("maps http(s) to ws(s) and appends /api", () => {
    expect(apiUrl("https://os.acme.dev")).toBe("wss://os.acme.dev/api");
    expect(apiUrl("http://localhost:8787")).toBe("ws://localhost:8787/api");
  });
});

describe("withDeadline", () => {
  test("passes through resolution and rejection", async () => {
    await expect(withDeadline(Promise.resolve(42), "x()")).resolves.toBe(42);
    await expect(withDeadline(Promise.reject(new Error("boom")), "x()")).rejects.toThrow("boom");
  });
  test("times out with the call name", async () => {
    await expect(withDeadline(new Promise(() => {}), "getServerConfig()", 20)).rejects.toThrow(
      /getServerConfig\(\) timed out/,
    );
  });
});
