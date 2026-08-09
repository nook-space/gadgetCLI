// `gadget update` — the explicit, user-invoked update. The passive notice never
// mutates anything; this does, and only because you asked.

import { spawnSync } from "node:child_process";
import { CliError, EXIT } from "../../errors.js";
import {
  detectInstallMethod, isNewer, runnableUpdateCommand, stampCheck, updateAdvice,
} from "../../update.js";
import { PACKAGE_NAME, VERSION } from "../../version.js";
import { refreshSkills } from "./skill.js";

export type UpdateOptions = { check?: boolean };

export async function update(opts: UpdateOptions): Promise<void> {
  const latest = await fetchLatest();
  if (latest === undefined) {
    throw new CliError(`cannot reach the npm registry to check for updates`, {
      hint: "check your network, or update with your package manager directly",
      exitCode: EXIT.rpc,
    });
  }
  stampCheck(latest);

  if (latest === null) {
    console.log(`${PACKAGE_NAME} is not published to npm (nothing to update from)`);
    return;
  }
  if (!isNewer(latest, VERSION)) {
    console.log(`already up to date (${VERSION})`);
    return;
  }
  console.log(`update available: ${VERSION} → ${latest}`);
  if (opts.check) return;

  const method = detectInstallMethod();
  const command = runnableUpdateCommand(method);
  if (!command) {
    // npx refetches, a source checkout uses git, and a Homebrew formula/tap name is the
    // operator's choice — recommend rather than guess-run.
    console.log(`run: ${updateAdvice(method)}`);
    return;
  }

  console.log(`running: ${command}`);
  const [file, ...args] = command.split(" ");
  const result = spawnSync(file!, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new CliError("the update command failed", {
      hint: `run it yourself: ${command} (a global install may need different permissions)`,
      exitCode: EXIT.error,
    });
  }

  // The skill is copied, not linked, so an updated CLI leaves stale copies behind.
  refreshSkills();
}

// null = published lookup succeeded but no such package; undefined = could not check.
async function fetchLatest(): Promise<string | null | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    return ((await response.json()) as { version?: string }).version ?? null;
  } catch {
    return undefined;
  }
}
