import type { DiffLine, FileDiff, FileStatus, Hunk } from "../types";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Decodes a C-style quoted path as git prints it, e.g. "a/caf\303\251.txt". */
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const next = s[++i];
    if (next >= "0" && next <= "7") {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Reads a possibly-quoted path at the start of `s`; returns it and the rest. */
function readPath(s: string): [string, string] {
  if (s.startsWith('"')) {
    let i = 1;
    while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
    return [unquote(s.slice(0, i + 1)), s.slice(i + 2)];
  }
  return [s, ""];
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Paths from `diff --git a/X b/Y`. Ambiguous with spaces; later header lines override. */
function parseGitHeader(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    const [a, after] = readPath(rest);
    const [b] = readPath(after);
    return [stripPrefix(a, "a/"), stripPrefix(unquote(b), "b/")];
  }
  if (rest.endsWith('"')) {
    const q = rest.lastIndexOf(' "');
    return [stripPrefix(rest.slice(0, q), "a/"), stripPrefix(unquote(rest.slice(q + 1)), "b/")];
  }
  // Same path on both sides: "a/P b/P".
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && len > 0) {
    const a = rest.slice(2, 2 + len);
    const b = rest.slice(5 + len);
    if (a === b && rest.startsWith("a/") && rest.slice(2 + len, 5 + len) === " b/") return [a, b];
  }
  const i = rest.indexOf(" b/");
  if (i >= 0) return [stripPrefix(rest.slice(0, i), "a/"), rest.slice(i + 3)];
  return [null, null];
}

/** Path from a `--- a/x` / `+++ b/x` line. */
function parseFileLine(rest: string, prefix: string): string | null {
  // git appends a tab when the name contains a space.
  const raw = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
  const path = unquote(raw);
  if (path === "/dev/null") return null;
  return stripPrefix(path, prefix);
}

interface Builder {
  file: FileDiff;
  sawNull: { old: boolean; new: boolean };
}

function newFile(oldPath: string | null, newPath: string | null): Builder {
  return {
    file: {
      id: "",
      oldPath,
      newPath,
      path: "",
      status: "modified",
      binary: false,
      oldMode: null,
      newMode: null,
      oldBlob: null,
      newBlob: null,
      similarity: null,
      hunks: [],
      additions: 0,
      deletions: 0,
    },
    sawNull: { old: false, new: false },
  };
}

function finish(b: Builder): FileDiff {
  const f = b.file;
  if (b.sawNull.old || f.status === "added") {
    f.oldPath = null;
    f.status = "added";
  }
  if (b.sawNull.new || f.status === "deleted") {
    f.newPath = null;
    f.status = "deleted";
  }
  f.path = f.newPath ?? f.oldPath ?? "";
  f.id = fileId(f.oldPath, f.newPath);
  return f;
}

export function fileId(oldPath: string | null, newPath: string | null): string {
  return `${oldPath ?? ""}\u0000${newPath ?? ""}`;
}

/** Parses the output of `git diff` (unified format with git extended headers). */
export function parsePatch(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let cur: Builder | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const setStatus = (s: FileStatus) => {
    if (cur) cur.file.status = s;
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Inside a hunk, the line counts decide what is content.
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (line.endsWith("\r") && i < lines.length - 1) line = line.slice(0, -1);
      let dl: DiffLine | null = null;
      if (c === "+") {
        dl = { type: "add", text: line.slice(1), oldNo: null, newNo: newNo++ };
        newLeft--;
        cur!.file.additions++;
      } else if (c === "-") {
        dl = { type: "del", text: line.slice(1), oldNo: oldNo++, newNo: null };
        oldLeft--;
        cur!.file.deletions++;
      } else if (c === " " || line === "") {
        dl = { type: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
        oldLeft--;
        newLeft--;
      } else if (c === "\\") {
        continue; // "\ No newline at end of file"
      } else {
        hunk = null; // malformed; fall through to header handling
      }
      if (dl) {
        hunk!.lines.push(dl);
        continue;
      }
    }
    if (line.startsWith("\\")) continue;

    if (line.startsWith("diff --git ")) {
      if (cur) files.push(finish(cur));
      const [a, b] = parseGitHeader(line.slice(11));
      cur = newFile(a, b);
      hunk = null;
      continue;
    }
    if (!cur) continue;

    const m = HUNK_RE.exec(line);
    if (m) {
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      hunk = {
        oldStart: Number(m[1]),
        oldLines,
        newStart: Number(m[3]),
        newLines,
        header: line,
        lines: [],
      };
      cur.file.hunks.push(hunk);
      oldLeft = oldLines;
      newLeft = newLines;
      oldNo = oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
      newNo = newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
      continue;
    }
    if (hunk) continue;

    const f = cur.file;
    if (line.startsWith("--- ")) {
      const p = parseFileLine(line.slice(4), "a/");
      if (p === null) cur.sawNull.old = true;
      else f.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = parseFileLine(line.slice(4), "b/");
      if (p === null) cur.sawNull.new = true;
      else f.newPath = p;
    } else if (line.startsWith("new file mode ")) {
      f.newMode = line.slice(14);
      setStatus("added");
    } else if (line.startsWith("deleted file mode ")) {
      f.oldMode = line.slice(18);
      setStatus("deleted");
    } else if (line.startsWith("old mode ")) {
      f.oldMode = line.slice(9);
    } else if (line.startsWith("new mode ")) {
      f.newMode = line.slice(9);
    } else if (line.startsWith("rename from ")) {
      f.oldPath = unquote(line.slice(12));
      setStatus("renamed");
    } else if (line.startsWith("rename to ")) {
      f.newPath = unquote(line.slice(10));
      setStatus("renamed");
    } else if (line.startsWith("copy from ")) {
      f.oldPath = unquote(line.slice(10));
      setStatus("copied");
    } else if (line.startsWith("copy to ")) {
      f.newPath = unquote(line.slice(8));
      setStatus("copied");
    } else if (line.startsWith("similarity index ")) {
      f.similarity = parseInt(line.slice(17), 10);
    } else if (line.startsWith("index ")) {
      const im = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?/.exec(line);
      if (im) {
        f.oldBlob = im[1];
        f.newBlob = im[2];
        if (im[3]) {
          f.oldMode ??= im[3];
          f.newMode ??= im[3];
        }
      }
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      f.binary = true;
      if (line.startsWith("Binary files /dev/null ")) cur.sawNull.old = true;
      if (line.endsWith(" and /dev/null differ")) cur.sawNull.new = true;
    }
  }
  if (cur) files.push(finish(cur));
  return files;
}

/**
 * In paths mode, git prints the compared paths in full (absolute, minus the
 * leading slash). Make them relative to the compared roots.
 */
export function relativizePaths(files: FileDiff[], leftRoot: string, rightRoot: string, fileName: string | null): FileDiff[] {
  const norm = (p: string) => p.replace(/^\/+/, "").replace(/\/+$/, "");
  const left = norm(leftRoot);
  const right = norm(rightRoot);
  const rel = (p: string | null): string | null => {
    if (p === null) return null;
    const n = norm(p);
    for (const root of [left, right]) {
      if (n === root) return fileName ?? n.split("/").pop()!;
      if (n.startsWith(root + "/")) return n.slice(root.length + 1);
    }
    return n;
  };
  return files.map((f) => {
    const oldPath = rel(f.oldPath);
    const newPath = rel(f.newPath);
    // Comparing two single files is a modification, never a rename.
    const status = fileName && f.status === "renamed" ? "modified" : f.status;
    return { ...f, oldPath, newPath, status, path: newPath ?? oldPath ?? "", id: fileId(oldPath, newPath) };
  });
}

/**
 * Combines the full patch (which defines the file list) with the patch made
 * with `-w`. Files missing from the `-w` patch only had whitespace changes.
 */
export function applyIgnoreWhitespace(full: FileDiff[], ws: FileDiff[]): FileDiff[] {
  const byId = new Map(ws.map((f) => [f.id, f]));
  const byPath = new Map(ws.map((f) => [f.path, f]));
  return full.map((f) => {
    const w = byId.get(f.id) ?? byPath.get(f.path);
    if (w) return { ...f, hunks: w.hunks, additions: w.additions, deletions: w.deletions };
    if (f.binary || f.hunks.length === 0) return f;
    return { ...f, hunks: [], additions: 0, deletions: 0, whitespaceOnly: true };
  });
}
