// Client-side password hashing per the upstream spec on PublicApi.login():
// argon2id over salt = SERVICE_SALT + utf8(username), parallelism 1, iterations 3,
// memory 64 MiB, 32-byte digest. The server never sees the password, only this hash
// (which it hashes again). The username is used as typed — no case folding — because
// the server compares hashes verbatim and salts with what the user typed at signup.

import { argon2id } from "hash-wasm";
import { SERVICE_SALT } from "./constants.js";

export async function hashPassword(username: string, password: string): Promise<Uint8Array> {
  const name = new TextEncoder().encode(username);
  const salt = new Uint8Array(SERVICE_SALT.length + name.length);
  salt.set(SERVICE_SALT);
  salt.set(name, SERVICE_SALT.length);

  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536, // KiB = 64 MiB
    hashLength: 32,
    outputType: "binary",
  });
}
