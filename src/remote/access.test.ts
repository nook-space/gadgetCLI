import { describe, expect, test } from "vitest";
import { isAccessChallenge } from "./access.js";

describe("isAccessChallenge", () => {
  test("recognizes an Access redirect by its login host", () => {
    // The shape an Access-gated instance answers an unauthenticated request with.
    expect(isAccessChallenge(
      "https://example-team.cloudflareaccess.com/cdn-cgi/access/login/os.example.com?kid=abc",
      "",
    )).toBe(true);
  });

  test("recognizes the challenge header on its own", () => {
    expect(isAccessChallenge("", 'Cloudflare-Access resource_metadata="https://x/.well-known/y"'))
      .toBe(true);
  });

  test("an ordinary redirect or missing headers is not an Access gate", () => {
    expect(isAccessChallenge("https://example.com/login", "")).toBe(false);
    expect(isAccessChallenge("", "Bearer realm=x")).toBe(false);
    expect(isAccessChallenge("", "")).toBe(false);
  });
});
