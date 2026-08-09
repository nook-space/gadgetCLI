import { mkdirSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { CliError, EXIT } from "../../errors.js";
import { isIgnored, materialize } from "../../sync/files.js";
import { loadManifest, saveManifest } from "../../sync/state.js";

// The starter gadget follows the upstream idiom exactly: server.js exports a Durable
// Object class named `Gadget` (state in storage, not memory); client.js builds the
// whole UI in the sandboxed iframe and talks to the server via the `gadget` RPC stub.
const TEMPLATES: Record<string, string> = {
  "server.js": `import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  async increment() {
    let count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }

  async getCount() {
    return (await this.ctx.storage.get("count")) ?? 0;
  }
}
`,
  "client.js": `// \`gadget\` is an RPC stub for the Gadget class in server.js.
const label = document.createElement("p");
const button = document.createElement("button");
button.textContent = "increment";

function show(count) {
  label.textContent = \`count: \${count}\`;
}

button.onclick = async () => show(await gadget.increment());
document.body.append(button, label);
gadget.getCount().then(show);
`,
  "README.md": `A counter gadget. server.js holds the count in Durable Object storage;
client.js renders it and calls the server over the \`gadget\` RPC stub.
`,
};

export async function newProject(
  dirArg: string,
  opts: { title?: string; from?: string },
): Promise<void> {
  const dir = resolve(process.cwd(), dirArg);
  mkdirSync(dir, { recursive: true });
  // Probe emptiness by names only — reading content would misreport a jpeg in the
  // directory as a UTF-8 error instead of "not empty".
  const occupied = readdirSync(dir).some((name) => !isIgnored(name));
  if (loadManifest(dir) || occupied) {
    throw new CliError(`directory is not empty: ${dir}`, {
      hint: "scaffold into a new or empty directory",
      exitCode: EXIT.usage,
    });
  }

  if (opts.from) {
    const { newFrom } = await import("./blueprint.js");
    return newFrom(opts.from, dir, opts.title);
  }

  const files = new Map(Object.entries(TEMPLATES));
  materialize(dir, files, files.keys());
  saveManifest(dir, { title: opts.title ?? basename(dir) });

  console.log(`scaffolded ${dirArg}: ${[...files.keys()].join(", ")}`);
  console.log("next: edit the files, then run gadget push --new");
}
