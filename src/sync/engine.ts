// Wire-facing sync: open a workspace, learn its workpieces, move code both ways.
// Everything here follows the session lifecycle rules (see remote/session.ts).

import { RpcStub, RpcTarget } from "capnweb";
import * as Y from "yjs";
import { CliError, EXIT } from "../errors.js";
import { OPEN_GADGET_ERROR_CODES } from "../remote/constants.js";
import { validateFileName } from "./files.js";
import type { Session } from "../remote/session.js";
import type { AuthedContext } from "../remote/authed.js";
import type {
  CodeUpdate, Overseer, WorkpieceSummary,
} from "../remote/types.js";

// Code sync can move real data; give it more room than a single call.
const SYNC_DEADLINE_MS = 60_000;

export async function openWorkspace(
  ctx: AuthedContext,
  id: string,
): Promise<RpcStub<Overseer>> {
  try {
    return (await ctx.session.rpc(ctx.authed.openGadget(id), "openGadget()")) as unknown as RpcStub<Overseer>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === OPEN_GADGET_ERROR_CODES.workspaceNotFound) {
      throw new CliError(`workspace not found: ${id}`, {
        hint: "run: gadget list",
        exitCode: EXIT.usage,
      });
    }
    if (code === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied) {
      throw new CliError(`you do not have access to workspace ${id}`, { exitCode: EXIT.auth });
    }
    throw err;
  }
}

// Drive subscribeToWorkpieces to ready() and return the gadget list.
export async function listWorkpieces(
  session: Session,
  overseer: RpcStub<Overseer>,
): Promise<WorkpieceSummary[]> {
  const summaries = new Map<number, WorkpieceSummary>();
  let settle!: () => void;
  const ready = new Promise<void>((resolve) => (settle = resolve));

  class Subscriber extends RpcTarget {
    entry(summary: WorkpieceSummary) {
      summaries.set(summary.id, summary);
    }
    removed(id: number) {
      summaries.delete(id);
    }
    ready() {
      settle();
    }
  }

  using subscriber = new RpcStub(new Subscriber());
  using _sub = await session.rpc(
    overseer.subscribeToWorkpieces(subscriber as never),
    "subscribeToWorkpieces()",
  );
  await session.rpc(ready, "workpiece list", SYNC_DEADLINE_MS);
  return [...summaries.values()];
}

// Which gadget does this project mean? Provisional gadgets (chatId set) belong to a
// chat's proposed changes and are never selectable.
export function resolveGadget(
  workpieces: WorkpieceSummary[],
  wanted?: number,
): WorkpieceSummary {
  const gadgets = workpieces.filter((w) => w.type === "gadget" && w.chatId === undefined);
  if (wanted !== undefined) {
    const found = gadgets.find((g) => g.id === wanted);
    if (!found) {
      throw new CliError(`no gadget ${wanted} in this workspace`, {
        hint: gadgets.length ? `gadgets: ${describe(gadgets)}` : "the workspace has no gadgets",
        exitCode: EXIT.usage,
      });
    }
    return found;
  }
  if (gadgets.length === 1) return gadgets[0]!;
  if (gadgets.length === 0) {
    throw new CliError("this workspace has no gadgets", { exitCode: EXIT.usage });
  }
  throw new CliError("this workspace has several gadgets; pick one", {
    hint: `pass --gadget <id>; gadgets: ${describe(gadgets)}`,
    exitCode: EXIT.usage,
  });
}

function describe(gadgets: WorkpieceSummary[]): string {
  return gadgets.map((g) => `${g.id}: ${g.title}`).join(", ");
}

// The files root is authoritative from the summary — legacy workspaces use "", newer
// gadgets their decimal id — and is never computed client-side.
export function filesRootOf(summary: WorkpieceSummary): string {
  if (summary.filesRoot === undefined) {
    throw new CliError(`gadget ${summary.id} exposes no files root`, {
      hint: "the instance may be newer than this CLI; update gadget-cli",
    });
  }
  return summary.filesRoot;
}

// Apply all updates after `fromVersion` onto `doc`, returning the last version seen.
// Updates are applied synchronously in delivery order, per the upstream contract.
export async function fetchCode(
  session: Session,
  overseer: RpcStub<Overseer>,
  doc: Y.Doc,
  fromVersion: number,
): Promise<number> {
  let version = fromVersion;
  let settle!: () => void;
  let broke!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    broke = reject;
  });

  class Subscriber extends RpcTarget {
    update(up: CodeUpdate) {
      try {
        Y.applyUpdateV2(doc, up.update);
        version = up.version;
      } catch (err) {
        broke(new CliError("the server sent an update the local base cannot apply", {
          cause: err,
          hint: "delete the .gadget directory and run gadget pull again",
        }));
      }
    }
    ready() {
      settle();
    }
  }

  using subscriber = new RpcStub(new Subscriber());
  using _sub = await session.rpc(
    overseer.subscribeToCode(subscriber as never, fromVersion),
    "subscribeToCode()",
  );
  await session.rpc(ready, "code sync", SYNC_DEADLINE_MS);
  return version;
}

// Encode `files` as one Yjs update against `doc`'s current root content: whole-file
// replace per changed file, delete per removed file. Returns null when nothing changed.
// This is the same technique upstream's own blueprint instantiation uses.
export function buildUpdate(
  doc: Y.Doc,
  root: string,
  files: Map<string, string>,
): Uint8Array | null {
  for (const name of files.keys()) validateFileName(name);
  const updates: Uint8Array[] = [];
  const capture = (update: Uint8Array) => updates.push(update);
  doc.on("updateV2", capture);
  try {
    doc.transact(() => {
      const map = doc.getMap<Y.Text>(root);
      for (const [name, content] of files) {
        const existing = map.get(name);
        if (existing === undefined) {
          const text = new Y.Text();
          text.insert(0, content);
          map.set(name, text);
        } else if (existing.toString() !== content) {
          existing.delete(0, existing.length);
          existing.insert(0, content);
        }
      }
      for (const name of map.keys()) {
        if (!files.has(name)) map.delete(name);
      }
    });
  } finally {
    doc.off("updateV2", capture);
  }
  if (updates.length === 0) return null;
  return updates.length === 1 ? updates[0]! : Y.mergeUpdatesV2(updates);
}
