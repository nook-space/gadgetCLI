import { argon2id } from "hash-wasm";
import { describe, expect, test } from "vitest";
import { hashPassword } from "./auth.js";
import { SERVICE_SALT } from "./constants.js";

describe("hashPassword", () => {
  test("derives a 32-byte digest with salt = SERVICE_SALT + utf8(username)", async () => {
    const username = "Alice"; // mixed case on purpose: no folding allowed
    const password = "correct horse";

    const name = new TextEncoder().encode(username);
    const salt = new Uint8Array([...SERVICE_SALT, ...name]);
    const expected = await argon2id({
      password,
      salt,
      parallelism: 1,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: "binary",
    });

    const actual = await hashPassword(username, password);
    expect(actual).toHaveLength(32);
    expect(actual).toEqual(expected);
  });

  test("username case changes the hash (no folding)", async () => {
    const a = await hashPassword("alice", "pw");
    const b = await hashPassword("Alice", "pw");
    expect(a).not.toEqual(b);
  });

  test("known-answer vector pins SERVICE_SALT and parameters against drift", async () => {
    // Derived once from the upstream spec (api.ts SERVICE_SALT + documented params).
    // A change in the salt bytes, params, or library behavior fails this immediately.
    const digest = Buffer.from(await hashPassword("alice", "correct horse battery")).toString("hex");
    expect(digest).toBe("53c682eacea50c64a0e96904a5a94437835380af77c88cf8376824cd6591a0c1");
  });

  test("multibyte usernames salt by utf8 bytes", async () => {
    const a = await hashPassword("amïr", "pw");
    const b = await hashPassword("amir", "pw");
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
  });
});
