import { describe, expect, test } from "vitest";
import type { BlueprintMetadata } from "../remote/types.js";
import {
  ARCHIVE_MAGIC, MAX_METADATA_BYTES, packArchive, parseArchive,
} from "./codec.js";

const metadata: BlueprintMetadata = {
  title: "Counter",
  description: "a counter",
  author: { type: "user", id: "amir", name: "amir" },
  created: new Date("2026-08-01T00:00:00Z"),
  version: 1,
  lastUpdated: new Date("2026-08-09T00:00:00Z"),
  bindings: {},
};

const files = new Map([
  ["server.js", "export class Gadget {} // héllo 💜\n"],
  ["client.js", "document.body.textContent = 'hi';\n"],
  ["lib/util.js", "export const n = 1;\n"],
]);

describe("archive codec", () => {
  test("round-trips files and metadata byte-exactly", () => {
    const bytes = packArchive(metadata, files);
    const parsed = parseArchive(bytes);
    expect(parsed.files).toEqual(files);
    expect(parsed.metadata.title).toBe("Counter");
    expect(parsed.metadata.created).toEqual(metadata.created);
    expect(parsed.metadata.bindings).toEqual({});
  });

  test("the prefix matches the upstream layout bit for bit", () => {
    const bytes = packArchive(metadata, files);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getBigUint64(0)).toBe(ARCHIVE_MAGIC);
    expect(view.getBigUint64(0).toString(16)).toBe("ec2e2d3a2300e317");
    expect(view.getUint32(8)).toBe(1);
    expect(view.getUint32(12)).toBeGreaterThan(0); // metadata length
    expect(Number(view.getBigUint64(16))).toBe(bytes.byteLength - 24 - view.getUint32(12));
  });

  test("rejects bad magic, versions, truncation, and length lies", () => {
    const good = packArchive(metadata, files);

    const badMagic = good.slice();
    badMagic[0] = 0x00;
    expect(() => parseArchive(badMagic)).toThrow(/magic/);

    const badVersion = good.slice();
    new DataView(badVersion.buffer).setUint32(8, 2);
    expect(() => parseArchive(badVersion)).toThrow(/version: 2/);

    expect(() => parseArchive(good.subarray(0, 10))).toThrow(/truncated/);
    expect(() => parseArchive(good.subarray(0, good.byteLength - 3))).toThrow(/truncated/);

    const lyingLength = good.slice();
    new DataView(lyingLength.buffer).setBigUint64(16, BigInt(1024 * 1024 * 1024));
    expect(() => parseArchive(lyingLength)).toThrow(/out of range/);
  });

  test("caps oversized metadata and refuses hostile names inside archives", () => {
    const big = { ...metadata, description: "x".repeat(MAX_METADATA_BYTES + 1) };
    expect(() => packArchive(big, files)).toThrow(/too large/);
    expect(() => packArchive(metadata, new Map([["../evil", "x"]]))).toThrow(/unsafe file name/);
  });

  test("garbage after a valid prefix fails as gzip, not as a crash", () => {
    const bytes = packArchive(metadata, files);
    const tampered = bytes.slice();
    tampered.fill(0xaa, 24 + new DataView(bytes.buffer).getUint32(12));
    expect(() => parseArchive(tampered)).toThrow(/not valid gzip/);
  });
});
