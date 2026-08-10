// Background update check, spawned detached by src/update.ts. Fetches the registry's
// latest version and writes the cache, then exits. Never touches the user's command:
// it runs in its own process, and any failure just leaves the cache alone.
//
// argv: <cachePath> <packageName>

const [cachePath, packageName] = process.argv.slice(2);

if (cachePath && packageName) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    // A 404 means "not published under this name" — cache the check time anyway so we
    // don't re-ask every run, but record no version.
    const latest = response.ok
      ? ((await response.json()) as { version?: string }).version
      : undefined;
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ checkedAt: new Date().toISOString(), latest: latest ?? null }),
    );
  } catch {
    // Offline, DNS failure, timeout: leave the old cache in place and try again later.
  }
}
