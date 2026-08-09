// The .gadget archive codec, byte-compatible with upstream (docs/blueprints.md and
// blueprint-archive.ts): 24-byte prefix (8 magic, 4 format version, 4 metadata length,
// 8 content length, big-endian), UTF-8 JSON BlueprintMetadata, then the gzip-compressed
// Yjs V2 snapshot of a doc whose UNNAMED root map is filename → Y.Text, one insert per
// file. Caps mirror upstream's import validation; parsing bounds every allocation.

import { gunzipSync, gzipSync } from "node:zlib";
import * as Y from "yjs";
import { CliError } from "../errors.js";
import type { BlueprintMetadata } from "../remote/types.js";
import { docFiles, validateFileName } from "../sync/files.js";

export const ARCHIVE_MAGIC = 0xec2e2d3a2300e317n;
export const ARCHIVE_VERSION = 1;
const PREFIX_BYTES = 24;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
// The compressed cap is upstream's; the decompression bound is ours, against zip bombs.
const MAX_SNAPSHOT_BYTES = 8 * MAX_CONTENT_BYTES;

export function packArchive(metadata: BlueprintMetadata, files: Map<string, string>): Uint8Array {
  const doc = new Y.Doc();
  const root = doc.getMap<Y.Text>();
  for (const [name, content] of files) {
    validateFileName(name);
    const text = new Y.Text();
    text.insert(0, content);
    root.set(name, text);
  }
  const content = gzipSync(Y.encodeStateAsUpdateV2(doc));
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) {
    throw new CliError("blueprint metadata is too large (max 64 KiB)");
  }
  if (content.byteLength > MAX_CONTENT_BYTES) {
    throw new CliError("blueprint content is too large (max 32 MiB compressed)");
  }

  const out = new Uint8Array(PREFIX_BYTES + metadataBytes.byteLength + content.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, ARCHIVE_MAGIC);
  view.setUint32(8, ARCHIVE_VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  out.set(metadataBytes, PREFIX_BYTES);
  out.set(content, PREFIX_BYTES + metadataBytes.byteLength);
  return out;
}

export function parseArchive(bytes: Uint8Array): {
  metadata: BlueprintMetadata;
  files: Map<string, string>;
} {
  if (bytes.byteLength < PREFIX_BYTES) throw new CliError("truncated .gadget archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getBigUint64(0) !== ARCHIVE_MAGIC) {
    throw new CliError("not a .gadget archive (bad magic number)");
  }
  const version = view.getUint32(8);
  if (version !== ARCHIVE_VERSION) {
    throw new CliError(`unsupported .gadget archive version: ${version}`);
  }
  const metadataSize = view.getUint32(12);
  if (metadataSize === 0 || metadataSize > MAX_METADATA_BYTES) {
    throw new CliError("archive metadata size is out of range");
  }
  const contentLength = Number(view.getBigUint64(16));
  if (!Number.isSafeInteger(contentLength) || contentLength < 0 ||
      contentLength > MAX_CONTENT_BYTES) {
    throw new CliError("archive content length is out of range");
  }
  if (bytes.byteLength !== PREFIX_BYTES + metadataSize + contentLength) {
    throw new CliError("truncated .gadget archive");
  }

  let metadata: BlueprintMetadata;
  try {
    metadata = JSON.parse(
      new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataSize)),
    ) as BlueprintMetadata;
  } catch {
    throw new CliError("archive metadata is not valid JSON");
  }
  metadata.created = new Date(metadata.created);
  metadata.lastUpdated = new Date(metadata.lastUpdated);

  let snapshot: Buffer;
  try {
    snapshot = gunzipSync(bytes.subarray(PREFIX_BYTES + metadataSize), {
      maxOutputLength: MAX_SNAPSHOT_BYTES,
    });
  } catch (cause) {
    throw new CliError("archive content is not valid gzip (or too large)", { cause });
  }
  const doc = new Y.Doc();
  try {
    Y.applyUpdateV2(doc, snapshot);
  } catch (cause) {
    throw new CliError("archive content is not a valid code snapshot", { cause });
  }
  return { metadata, files: docFiles(doc, "") };
}
