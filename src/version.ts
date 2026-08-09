// Kept in lockstep with package.json by hand; the build has no JSON-import step to drift.
export const VERSION = "0.1.0";

// The published npm package name, used only by the update check. Until this package is
// published under this exact name the registry lookup 404s, which the check treats as
// "nothing to report" — so an unpublished or renamed package never nags.
export const PACKAGE_NAME = "gadget-cli";
