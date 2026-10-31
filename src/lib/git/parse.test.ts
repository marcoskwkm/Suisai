import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyIgnoreWhitespace, parsePatch, relativizePaths, unquote } from "./parse";

const fixture = readFileSync(new URL("./__fixtures__/staged.patch", import.meta.url), "utf8");

describe("parsePatch", () => {
  const files = parsePatch(fixture);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

  it("finds every file", () => {
    expect(files.map((f) => f.path)).toEqual([
      "added.txt",
      "b.bin",
      "café.txt",
      "del.txt",
      "new name.txt",
      "run.sh",
      "sql.txt",
    ]);
  });

  it("detects added and deleted files", () => {
    expect(byPath["added.txt"]).toMatchObject({ status: "added", oldPath: null, newPath: "added.txt", additions: 1 });
    expect(byPath["added.txt"].hunks[0].lines).toEqual([{ type: "add", text: "new", oldNo: null, newNo: 1 }]);
    expect(byPath["del.txt"]).toMatchObject({ status: "deleted", oldPath: "del.txt", newPath: null, deletions: 1 });
    expect(byPath["del.txt"].oldBlob).toBe("2fa992c0b8b5c6acd2bdd4fa31de29d29799bdd5");
  });

  it("detects binary files", () => {
    expect(byPath["b.bin"]).toMatchObject({ binary: true, status: "modified", hunks: [] });
  });

  it("handles renames with spaces and the trailing tab", () => {
    const f = byPath["new name.txt"];
    expect(f).toMatchObject({ status: "renamed", oldPath: "old name.txt", newPath: "new name.txt", similarity: 87 });
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0].lines.filter((l) => l.type !== "context").map((l) => [l.type, l.text, l.oldNo, l.newNo])).toEqual([
      ["del", "d", 4, null],
      ["add", "D", null, 4],
    ]);
  });

  it("records mode-only changes", () => {
    expect(byPath["run.sh"]).toMatchObject({ status: "modified", oldMode: "100644", newMode: "100755", hunks: [] });
  });

  it("treats lines starting with '--' inside hunks as content", () => {
    const f = byPath["sql.txt"];
    expect(f.deletions).toBe(1);
    expect(f.hunks[0].lines[1]).toEqual({ type: "del", text: "-- sql comment", oldNo: 2, newNo: null });
    expect(f.hunks[0].lines[2]).toEqual({ type: "context", text: "line3", oldNo: 3, newNo: 2 });
  });

  it("ignores the no-newline marker", () => {
    expect(byPath["café.txt"].hunks[0].lines).toHaveLength(2);
  });

  it("decodes quoted paths", () => {
    const patch = [
      'diff --git "a/caf\\303\\251 \\"q\\".txt" "b/caf\\303\\251 \\"q\\".txt"',
      "index 1111111..2222222 100644",
      '--- "a/caf\\303\\251 \\"q\\".txt"',
      '+++ "b/caf\\303\\251 \\"q\\".txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parsePatch(patch)[0].path).toBe('café "q".txt');
  });

  it("parses multiple hunks and line numbers", () => {
    const patch = [
      "diff --git a/x b/x",
      "index 1111111..2222222 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,3 @@ fn main() {",
      " a",
      "+new",
      " b",
      "@@ -10,0 +12,1 @@",
      "+tail",
      "",
    ].join("\n");
    const [f] = parsePatch(patch);
    expect(f.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 2, 1, 3],
      [10, 0, 12, 1],
    ]);
    expect(f.hunks[1].lines[0]).toMatchObject({ type: "add", newNo: 12 });
    expect(f.hunks[0].lines.map((l) => [l.oldNo, l.newNo])).toEqual([
      [1, 1],
      [null, 2],
      [2, 3],
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parsePatch("")).toEqual([]);
  });
});

describe("unquote", () => {
  it("handles escapes", () => {
    expect(unquote('"a\\tb\\\\c"')).toBe("a\tb\\c");
    expect(unquote("plain")).toBe("plain");
  });
});

describe("relativizePaths", () => {
  it("strips --no-index roots", () => {
    const patch = [
      "diff --git a/tmp/l/sub/x.txt b/tmp/r/sub/x.txt",
      "index 1111111..2222222 100644",
      "--- a/tmp/l/sub/x.txt",
      "+++ b/tmp/r/sub/x.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/tmp/l/a.txt b/tmp/r/b.txt",
      "similarity index 100%",
      "rename from /tmp/l/a.txt",
      "rename to /tmp/r/b.txt",
      "diff --git a/tmp/r/new.txt b/tmp/r/new.txt",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/tmp/r/new.txt",
      "@@ -0,0 +1 @@",
      "+n",
      "",
    ].join("\n");
    const files = relativizePaths(parsePatch(patch), "/tmp/l", "/tmp/r", null);
    expect(files.map((f) => [f.status, f.oldPath, f.newPath])).toEqual([
      ["modified", "sub/x.txt", "sub/x.txt"],
      ["renamed", "a.txt", "b.txt"],
      ["added", null, "new.txt"],
    ]);
  });

  it("names single-file comparisons", () => {
    const patch = ["diff --git a/tmp/x_old.ts b/repo/x.ts", "index 1..2 100644", "--- a/tmp/x_old.ts", "+++ b/repo/x.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const [f] = relativizePaths(parsePatch(patch), "/tmp/x_old.ts", "/repo/x.ts", "src/x.ts");
    expect(f).toMatchObject({ oldPath: "src/x.ts", newPath: "src/x.ts", status: "modified" });
  });
});

describe("applyIgnoreWhitespace", () => {
  it("marks files that only changed whitespace", () => {
    const full = parsePatch(fixture);
    const ws = full.filter((f) => f.path !== "sql.txt");
    const merged = applyIgnoreWhitespace(full, ws);
    const sql = merged.find((f) => f.path === "sql.txt")!;
    expect(sql).toMatchObject({ whitespaceOnly: true, hunks: [] });
    expect(merged.find((f) => f.path === "b.bin")!.whitespaceOnly).toBeUndefined();
  });
});
