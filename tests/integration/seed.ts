// Seeds live-instance fixtures through the CLI's own remote/sync modules: fresh
// accounts, workspaces with gadgets and files, and remote edits for conflict tests.

import { createHash } from "node:crypto";
import * as Y from "yjs";
import { authenticate } from "../../src/remote/authed.js";
import { openSession } from "../../src/remote/session.js";
import {
  buildUpdate, fetchCode, filesRootOf, listWorkpieces, newWorkspace, openWorkspace, resolveGadget,
} from "../../src/sync/engine.js";
import { docFiles } from "../../src/sync/files.js";

let seq = 0;
export function freshName(prefix: string): string {
  return `${prefix}${Date.now()}${process.pid}${++seq}`;
}

// The server stores and compares these bytes verbatim (it never re-derives them), so
// integration seeding skips the 64 MiB argon2 in favor of a deterministic stand-in —
// the same shortcut upstream's own integration tests use.
function passwordHashFor(username: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`gadget-cli-test:${username}`).digest());
}

export async function seedUser(url: string): Promise<{ username: string; token: string }> {
  const username = freshName("seed");
  using session = openSession(url);
  const token = await session.rpc(
    session.api.createAccount(username, username, passwordHashFor(username)),
    "createAccount()",
  );
  if (!token) throw new Error(`seed signup failed for ${username}`);
  return { username, token };
}

export type SeedGadget = { title: string; files?: Record<string, string> };

export async function seedWorkspace(
  url: string,
  token: string,
  title: string,
  gadgets: SeedGadget[],
): Promise<{ workspaceId: string; gadgetIds: number[] }> {
  using session = openSession(url);
  const authed = await authenticate(session, token, "seed");
  using overseer = await newWorkspace({ session, authed });
  await session.rpc(overseer.setTitle(title), "setTitle()");
  for (const g of gadgets) {
    using gadget = await session.rpc(overseer.createGadget(g.title), "createGadget()");
    void gadget;
  }

  const workpieces = await listWorkpieces(session, overseer);
  const doc = new Y.Doc();
  await fetchCode(session, overseer, doc, 0);

  const gadgetIds: number[] = [];
  for (const g of gadgets) {
    // Key by title: the workpiece-list delivery order is not a contract.
    const summary = workpieces.find((w) => w.chatId === undefined && w.title === g.title);
    if (!summary) throw new Error(`seeded gadget not listed: ${g.title}`);
    gadgetIds.push(summary.id);
    if (g.files) {
      const update = buildUpdate(doc, filesRootOf(summary), new Map(Object.entries(g.files)));
      if (update) await session.rpc(overseer.updateCode(update), "updateCode()");
    }
  }

  const metadata = await session.rpc(overseer.getMetadata(), "getMetadata()");
  return { workspaceId: metadata.id, gadgetIds };
}

// Wake a gadget by calling a method on its server class over connectToGadget —
// the way a client UI (or the agent) would. Used to trigger console output.
export async function wakeGadget(
  url: string,
  token: string,
  workspaceId: string,
  method: string,
): Promise<void> {
  using session = openSession(url);
  const authed = await authenticate(session, token, "seed");
  const ctx = { session, authed, profileName: "seed", origin: session.origin,
    [Symbol.dispose]() {} };
  using overseer = await openWorkspace(ctx, workspaceId);
  const workpieces = await listWorkpieces(session, overseer);
  const summary = resolveGadget(workpieces, undefined);
  using gadget = await session.rpc(overseer.getGadget(summary.id), "getGadget()");
  using stub = await session.rpc(gadget.connectToGadget(), "connectToGadget()");
  await session.rpc(
    (stub as unknown as Record<string, () => Promise<unknown>>)[method]!(),
    `${method}()`,
  );
}

// Apply a remote edit to one gadget's files, as a collaborator or the web editor would.
export async function seedRemoteEdit(
  url: string,
  token: string,
  workspaceId: string,
  gadgetId: number | undefined,
  mutate: (files: Map<string, string>) => Map<string, string>,
): Promise<void> {
  using session = openSession(url);
  const authed = await authenticate(session, token, "seed");
  const ctx = { session, authed, profileName: "seed", origin: session.origin,
    [Symbol.dispose]() {} };
  using overseer = await openWorkspace(ctx, workspaceId);

  const workpieces = await listWorkpieces(session, overseer);
  const summary = resolveGadget(workpieces, gadgetId);
  const root = filesRootOf(summary);

  const doc = new Y.Doc();
  await fetchCode(session, overseer, doc, 0);
  const update = buildUpdate(doc, root, mutate(docFiles(doc, root)));
  if (update) await session.rpc(overseer.updateCode(update), "updateCode()");
}
