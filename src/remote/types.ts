// Vendored, type-only subset of the Cloudflare OS frontend API.
// Source: cloudflare-os packages/workshop-shared/src/{api,gatekeeper}.ts @ 1cb5e3d (Aug 2026).
//
// Deviation policy (the whole policy — anything else is a bug):
// - Interfaces may omit members we never call; object types may omit fields we never read.
// - Kept members keep upstream's exact name, parameter list, and optionality. No rewrites.
// - Deliberate narrowing: upstream `any` becomes `unknown` here. Nothing else changes.
// - Refresh = re-diff every kept member against a pinned upstream commit; update the pin above.
// Runtime values from the upstream spec (salt, error codes) live in constants.ts, never here.

import type { RpcStub, RpcTarget } from "capnweb";

// --- identity ---------------------------------------------------------------

export type AiChatAuthorInfo = {
  type: "user" | "agent" | "gadget";
  id: string;
  name: string;
};

// --- server config ----------------------------------------------------------

export type AvatarImage = { url: string };

export type AuthVendorInfo = {
  vendorId: string;
  displayName: string;
  logo?: AvatarImage;
  color?: string;
};

export type ServerConfig = {
  authVendors: AuthVendorInfo[];
  passwordAuthEnabled: boolean;
  cloudflareLimitsEnabled: boolean;
  signupsEnabled: boolean;
  siteName: string;
  announcement: string;
};

// --- code sync --------------------------------------------------------------

export type WorkpieceId = number;

export type CodeUpdate = {
  version: number;
  timestamp: Date;
  update: Uint8Array; // Yjs V2 encoding
};

export interface CodeSubscriber {
  update(up: CodeUpdate): void;
  ready(): void;
}

export type WorkpieceSummary = {
  id: WorkpieceId;
  type: "gadget";
  title: string;
  // Name of the Y.Doc root map holding this workpiece's files. Authoritative; never compute it.
  filesRoot?: string;
  // Present while the workpiece is provisional to a chat; such gadgets are not ours to touch.
  chatId?: number;
};

export interface WorkpiecesSubscriber {
  entry(summary: WorkpieceSummary): void;
  removed(id: WorkpieceId): void;
  ready(): void;
}

export interface ConsoleLogSubscriber {
  event(chatId: number | null, logs: ConsoleLogEvent[]): Promise<void>;
}

export type ConsoleLogEvent = {
  timestamp: Date;
  level: "debug" | "info" | "log" | "warn" | "error";
  message: unknown[]; // upstream: any[]
};

// --- workspaces -------------------------------------------------------------

export type GadgetMetadata = {
  id: string;
  title: string;
  owner?: AiChatAuthorInfo;
  role?: "build" | "use";
  defaultGadgetId?: WorkpieceId;
};

export type GadgetMetadataWithTimestamps = GadgetMetadata & {
  created: Date;
  lastActive: Date;
};

// --- blueprints -------------------------------------------------------------

export type BlueprintMetadata = {
  title: string;
  description: string;
  author: AiChatAuthorInfo;
  created: Date;
  version: number;
  lastUpdated: Date;
  screenshot?: true;
  // Key = binding name. The CLI treats binding specs as opaque; it only counts them.
  bindings: Record<string, unknown>;
};

export type BlueprintPublicInfo = {
  id: string;
  metadata: BlueprintMetadata;
  screenshotUrl?: string;
};

export type BlueprintGadgetSummary = {
  id: string;
  title: string;
  description: string;
  version: number;
  codeVersionDate: Date;
  dirty?: boolean;
};

export type BlueprintBindingAssignment = {
  type: "gatekeeper";
  accountId: number;
  resourceUrl: string;
} | {
  type: "aiModel";
  modelId: string;
} | {
  type: "agentSpawner";
  modelId: string | null;
};

export type BlueprintScreenshotUpload = {
  mimeType: "image/jpeg" | "image/png";
  content: Uint8Array;
};

// --- observer configuration (non-owner opens) --------------------------------

export type ObserverBindingNeed = {
  gatekeeperId: WorkpieceId;
  vendorId: string;
  resourceTitle: string;
  resourceUrl?: string;
};

export type ObserverAccountChoice = {
  gatekeeperId: WorkpieceId;
  accountId: number;
};

export interface ObserverConfigCallback extends RpcTarget {
  configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]>;
}

// --- per-gadget capability --------------------------------------------------

export interface GadgetClient extends RpcTarget {
  getId(): Promise<WorkpieceId>;
  getTitle(): Promise<string>;
  connectToGadget(chatId?: number): Promise<RpcStub<unknown>>; // upstream: RpcStub<any>
  createBlueprint(
    title?: string,
    description?: string,
    screenshot?: BlueprintScreenshotUpload,
  ): Promise<BlueprintGadgetSummary>;
}

// --- workspace capability ---------------------------------------------------

export interface Overseer extends RpcTarget {
  getMetadata(): Promise<GadgetMetadata>;
  setTitle(title: string): Promise<void>;
  subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>): Promise<RpcStub<{}>>;
  createGadget(title: string, chatId?: number, bindingName?: string): Promise<RpcStub<GadgetClient>>;
  getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>>;
  subscribeToCode(subscriber: RpcStub<CodeSubscriber>, fromVersion?: number): Promise<RpcStub<{}>>;
  updateCode(update: Uint8Array, chatId?: number): Promise<void>;
  subscribeToConsoleLogs(subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>>;
  listBlueprints(): Promise<BlueprintGadgetSummary[]>;
  updateBlueprint(blueprintId: string, options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
  }): Promise<void>;
}

// --- authenticated root -----------------------------------------------------

export interface AuthenticatedApi extends RpcTarget {
  whoami(): Promise<AiChatAuthorInfo>;
  listGadgets(): Promise<GadgetMetadataWithTimestamps[]>;
  openGadget(id: string, shareKey?: string,
             configureObservers?: RpcStub<ObserverConfigCallback>): Promise<RpcStub<Overseer>>;
  newGadget(): Promise<RpcStub<Overseer>>;
  newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>,
  ): Promise<RpcStub<Overseer>>;
  importBlueprint(archive: ReadableStream<Uint8Array>): Promise<string>;
}

// --- public root ------------------------------------------------------------

export interface LoginAttempt extends RpcTarget {
  wait(): Promise<string>;
}

export interface PublicApi extends RpcTarget {
  getServerConfig(): Promise<ServerConfig>;
  startGatekeeperLogin(vendorId: string): Promise<{ url: string; attempt: RpcStub<LoginAttempt> }>;
  authenticate(token: string): Promise<AuthenticatedApi>;
  // Authenticates from the Cloudflare Access session on the connection itself; the
  // deployment must sit behind Access with CF_ACCESS_AUD configured.
  authenticateFromCfAccess(): Promise<AuthenticatedApi>;
  login(username: string, passwordHash: Uint8Array): Promise<string | null>;
  createAccount(
    username: string,
    displayName: string,
    passwordHash: Uint8Array,
  ): Promise<string | null>;
  getBlueprint(id: string): Promise<BlueprintPublicInfo | null>;
  downloadBlueprint(id: string): Promise<ReadableStream<Uint8Array>>;
}
