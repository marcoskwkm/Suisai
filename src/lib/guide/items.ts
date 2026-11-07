// The units a review guide is made of: each hunk of a file, or the whole file
// when it changed without hunks (binary, rename, mode change, empty file).

import type { FileDiff, Hunk } from "../types";

export interface ChangeItem {
  /** Stable identity across reloads: same file and same changed lines. */
  key: string;
  file: FileDiff;
  /** Index into file.hunks, or null for a whole-file change. */
  hunk: number | null;
  additions: number;
  deletions: number;
}

/** 53-bit string hash (cyrb53). */
export function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const SIGN = { add: "+", del: "-", context: " " } as const;

/** The hunk's lines without line numbers, so moving it up or down keeps its key. */
function hunkBody(h: Hunk): string {
  return h.lines.map((l) => SIGN[l.type] + l.text).join("\n");
}

function fileBody(f: FileDiff): string {
  return ["file", f.status, f.oldPath, f.newPath, f.oldMode, f.newMode, f.binary, f.oldBlob, f.newBlob].join("\u0000");
}

/** Every change in the diff, in file order. */
export function changeItems(files: FileDiff[]): ChangeItem[] {
  const items: ChangeItem[] = [];
  const seen = new Map<string, number>();
  const push = (file: FileDiff, hunk: number | null, body: string, additions: number, deletions: number) => {
    const base = hash(file.path + "\u0000" + body);
    // Identical hunks in one file get distinct keys by occurrence.
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    items.push({ key: n ? `${base}.${n}` : base, file, hunk, additions, deletions });
  };
  for (const f of files) {
    if (f.hunks.length === 0) {
      push(f, null, fileBody(f), 0, 0);
      continue;
    }
    f.hunks.forEach((h, i) => {
      let add = 0;
      let del = 0;
      for (const l of h.lines) {
        if (l.type === "add") add++;
        else if (l.type === "del") del++;
      }
      push(f, i, hunkBody(h), add, del);
    });
  }
  return items;
}

/** Changed lines in an item, used to weigh how much of a diff is new. */
export const itemSize = (it: ChangeItem) => Math.max(1, it.additions + it.deletions);

const STATUS_TEXT = { added: "new file", deleted: "deleted file", modified: "modified", renamed: "renamed", copied: "copied" } as const;

/** One line describing an item, e.g. `src/a.ts @@ -1,3 +1,4 @@ fn x (+2 -1)`. */
export function describe(it: ChangeItem): string {
  const f = it.file;
  const path = f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : f.path;
  if (it.hunk === null) return `${path} (${wholeFileSummary(f)})`;
  const h = f.hunks[it.hunk];
  return `${path} ${h.header.trim()} (+${it.additions} -${it.deletions})`;
}

/** What changed in a file that has no hunks. */
export function wholeFileSummary(f: FileDiff): string {
  const parts: string[] = [STATUS_TEXT[f.status]];
  if (f.binary) parts.push("binary");
  else if (f.status === "added" || f.status === "deleted") parts.push("empty");
  if (f.oldMode && f.newMode && f.oldMode !== f.newMode) parts.push(`mode ${f.oldMode} → ${f.newMode}`);
  if (f.similarity !== null && f.status !== "modified") parts.push(`${f.similarity}% similar`);
  return parts.join(", ");
}

/** Generated files whose contents would only waste the agent's context. */
const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|Podfile\.lock|flake\.lock)$|\.min\.(js|css)$|\.map$|\.snap$/;

/** The item as text for a prompt, with long hunks shortened to `maxLines`. */
export function renderItem(id: string, it: ChangeItem, maxLines: number): string {
  const head = `### ${id} · ${describe(it)}`;
  if (it.hunk === null) return head;
  if (GENERATED.test(it.file.path)) return `${head}\n(generated file: contents omitted)`;
  const lines = it.file.hunks[it.hunk].lines;
  const shown = lines.slice(0, maxLines).map((l) => SIGN[l.type] + l.text);
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines`);
  return `${head}\n\`\`\`diff\n${shown.join("\n")}\n\`\`\``;
}
