// Runtime values from the upstream spec. Types live in types.ts; these are the only
// vendored bytes that execute. Source: workshop-shared/src/api.ts @ 1cb5e3d.

// Client-side password hashing salt prefix (api.ts SERVICE_SALT). The full salt is
// SERVICE_SALT + utf8(username), fed to argon2id per the spec on PublicApi.login().
export const SERVICE_SALT = new Uint8Array([
  0xd9, 0x4e, 0x54, 0x1d, 0x29, 0xc1, 0x03, 0x74, 0x73, 0x7e, 0xb3, 0xe3, 0x34, 0x6d, 0x8f, 0x21,
]);

// Stable error codes on expected openGadget() failures (api.ts OPEN_GADGET_ERROR_CODES).
export const OPEN_GADGET_ERROR_CODES = {
  workspaceNotFound: "WORKSPACE_NOT_FOUND",
  workspaceAccessDenied: "WORKSPACE_ACCESS_DENIED",
} as const;
