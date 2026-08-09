// Pure comparison of two file maps, and a small line diff for `gadget diff`.

export type ChangeKind = "added" | "modified" | "deleted";
export type FileChange = { path: string; kind: ChangeKind };

// Changes that turn `from` into `to`, sorted by path.
export function diffFiles(from: Map<string, string>, to: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, content] of to) {
    if (!from.has(path)) changes.push({ path, kind: "added" });
    else if (from.get(path) !== content) changes.push({ path, kind: "modified" });
  }
  for (const path of from.keys()) {
    if (!to.has(path)) changes.push({ path, kind: "deleted" });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function changedPaths(from: Map<string, string>, to: Map<string, string>): Set<string> {
  return new Set(diffFiles(from, to).map((c) => c.path));
}

// Unified diff of one file (LCS on lines, 3 lines of context). Small inputs only —
// gadget files are capped at 1 MiB and typically a few hundred lines.
export function unifiedDiff(path: string, from: string, to: string): string {
  const a = from.split("\n");
  const b = to.split("\n");

  // LCS table (a.length+1 x b.length+1).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  // Walk the table into a +/-/space line script.
  const script: { tag: " " | "-" | "+"; line: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      script.push({ tag: " ", line: a[i++]! });
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      script.push({ tag: "-", line: a[i++]! });
    } else {
      script.push({ tag: "+", line: b[j++]! });
    }
  }
  while (i < a.length) script.push({ tag: "-", line: a[i++]! });
  while (j < b.length) script.push({ tag: "+", line: b[j++]! });

  // Keep changed lines plus 3 lines of context; elide the rest with a separator.
  const keep = Array.from({ length: script.length }, () => false);
  script.forEach((op, at) => {
    if (op.tag === " ") return;
    for (let k = Math.max(0, at - 3); k <= Math.min(script.length - 1, at + 3); k++) keep[k] = true;
  });

  const lines: string[] = [`--- ${path}`, `+++ ${path}`];
  let elided = false;
  script.forEach((op, at) => {
    if (!keep[at]) {
      if (!elided) lines.push("@@");
      elided = true;
      return;
    }
    elided = false;
    lines.push(op.tag + op.line);
  });
  return lines.join("\n");
}
