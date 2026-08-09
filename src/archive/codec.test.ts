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

  // Hostile-archive regressions (phase-4 critique should-fixes 1-3).
  test("malformed metadata is normalized: missing bindings and non-string titles", () => {
    const evil = { ...metadata } as Record<string, unknown>;
    delete evil["bindings"];
    evil["title"] = 42;
    const parsed = parseArchive(packArchive(evil as never, files));
    expect(parsed.metadata.bindings).toEqual({});
    expect(parsed.metadata.title).toBe("untitled blueprint");
  });

  test("control characters in archive file names are refused", () => {
    const hostile = new Map([["evil\u001b[31m.js", "x"]]);
    expect(() => packArchive(metadata, hostile)).toThrow(/unsafe file name/);
  });

  test("a zip bomb trips the decompression bound", async () => {
    // 200 MiB of zeros compresses to ~200 KiB — over the 128 MiB output bound.
    const { gzipSync } = await import("node:zlib");
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024));
    const meta = new TextEncoder().encode(JSON.stringify(metadata));
    const out = new Uint8Array(24 + meta.byteLength + bomb.byteLength);
    const view = new DataView(out.buffer);
    view.setBigUint64(0, ARCHIVE_MAGIC);
    view.setUint32(8, 1);
    view.setUint32(12, meta.byteLength);
    view.setBigUint64(16, BigInt(bomb.byteLength));
    out.set(meta, 24);
    out.set(bomb, 24 + meta.byteLength);
    expect(() => parseArchive(out)).toThrow(/not valid gzip \(or too large\)/);
  });

  test("a single over-1MiB file inside a valid archive is refused", () => {
    const big = new Map([["big.txt", "x".repeat(1024 * 1024 + 1)]]);
    const bytes = packArchive(metadata, big);
    expect(() => parseArchive(bytes)).toThrow(/too large.*big\.txt/);
  });
});
