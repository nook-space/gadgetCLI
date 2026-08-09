import { loadConfig, saveConfig } from "../../config.js";
import { CliError, EXIT } from "../../errors.js";

export type LogoutOptions = { profile?: string; all?: boolean };

// Clears stored session tokens. Local only: upstream has no token revocation, so the
// server-side session stays valid until that lands — deleting the token just stops
// THIS machine from using it.
export function logout(opts: LogoutOptions): void {
  const config = loadConfig();
  const names = Object.keys(config.profiles);
  if (names.length === 0) {
    console.log("not logged in to any instance");
    return;
  }

  let removed: string[];
  if (opts.all) {
    removed = names;
    config.profiles = {};
    delete config.current;
  } else {
    const name = opts.profile ?? config.current ?? (names.length === 1 ? names[0] : undefined);
    if (!name) {
      throw new CliError("several profiles; pick one to log out", {
        hint: `pass --profile <name> (${names.join(", ")}), or --all for every instance`,
        exitCode: EXIT.usage,
      });
    }
    if (!config.profiles[name]) {
      throw new CliError(`no such profile: ${name}`, {
        hint: `known: ${names.join(", ")}`,
        exitCode: EXIT.usage,
      });
    }
    removed = [name];
    delete config.profiles[name];
    if (config.current === name) {
      const rest = Object.keys(config.profiles);
      // Auto-pick a sole survivor; otherwise leave no current (commands then ask for --profile).
      if (rest.length === 1) config.current = rest[0];
      else delete config.current;
    }
  }

  saveConfig(config);
  console.log(`logged out: ${removed.join(", ")}`);
  console.error("note: the local token is cleared; the server session is not revoked (upstream gap)");
}
