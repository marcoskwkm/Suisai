import { describe, expect, it } from "vitest";
import { parsePatch } from "../git/parse";
import { intralineDiff } from "./intraline";
import { buildRows, changeStarts, computeGaps, computeIntraline, expand, type Row } from "./rows";
import { segments } from "./segments";

const patch = [
  "diff --git a/x b/x",
  "index 1111111..2222222 100644",
  "--- a/x",
  "+++ b/x",
  "@@ -3,3 +3,4 @@",
  " c",
  "-d",
  "+D",
  "+D2",
  " e",
  "@@ -40,2 +41,2 @@",
  "-x",
  "+y",
  " z",
  "",
].join("\n");
const [file] = parsePatch(patch);

const summarize = (rows: Row[]) =>
  rows.map((r) =>
    r.kind === "expander"
      ? `E${r.gap}:${r.remaining}${r.up ? "↑" : ""}${r.down ? "↓" : ""}`
      : r.kind === "line"
        ? `${r.type[0]}${r.oldNo ?? "-"}/${r.newNo ?? "-"}`
        : `${r.left ? r.left.type[0] + r.left.no : "_"}|${r.right ? r.right.type[0] + r.right.no : "_"}`,
  );

describe("computeGaps", () => {
  it("computes gaps between and around hunks", () => {
    expect(computeGaps(file.hunks, 50, 51)).toEqual([
      { index: 0, oldStart: 1, newStart: 1, size: 2 },
      { index: 1, oldStart: 6, newStart: 7, size: 34 },
      { index: 2, oldStart: 42, newStart: 43, size: 9 },
    ]);
  });

  it("leaves the trailing gap unknown without contents", () => {
    expect(computeGaps(file.hunks, null, null)[2].size).toBeNull();
  });
});

describe("buildRows", () => {
  const gaps = computeGaps(file.hunks, 50, 51);

  it("builds unified rows", () => {
    expect(summarize(buildRows(file, "unified", gaps, {}, true))).toEqual([
      "E0:2↑",
      "c3/3",
      "d4/-",
      "a-/4",
      "a-/5",
      "c5/6",
      "E1:34↑↓",
      "d40/-",
      "a-/41",
      "c41/42",
      "E2:9↓",
    ]);
  });

  it("pairs changes in split rows", () => {
    expect(summarize(buildRows(file, "split", gaps, {}, true)).slice(1, 5)).toEqual(["c3|c3", "d4|a4", "_|a5", "c5|c6"]);
  });

  it("expands gaps", () => {
    let exp = expand({}, gaps[1], "down");
    exp = expand(exp, gaps[1], "up");
    const rows = summarize(buildRows(file, "unified", gaps, exp, true));
    expect(rows.filter((r) => r.startsWith("E1"))).toEqual([]);
    expect(rows).toContain("c6/7");
    expect(rows).toContain("c39/40");

    const all = summarize(buildRows(file, "unified", gaps, expand({}, gaps[0], "all"), true));
    expect(all.slice(0, 3)).toEqual(["c1/1", "c2/2", "c3/3"]);
  });

  it("partially expands large gaps", () => {
    const rows = summarize(buildRows(file, "unified", gaps, expand({}, gaps[1], "down"), true));
    const i = rows.indexOf("E1:14↑↓");
    expect(i).toBeGreaterThan(0);
    expect(rows[i - 1]).toBe("c25/26");
  });

  it("shows plain hunk headers without contents", () => {
    const rows = summarize(buildRows(file, "unified", computeGaps(file.hunks, null, null), {}, false));
    expect(rows.filter((r) => r.startsWith("E"))).toEqual(["E0:0", "E1:0"]);
  });

  it("finds change starts", () => {
    const rows = buildRows(file, "unified", gaps, {}, true);
    expect(changeStarts(rows)).toEqual([2, 7]);
  });
});

describe("intraline", () => {
  it("highlights changed words", () => {
    expect(intralineDiff("const foo = 1;", "const bar = 1;")).toEqual({ old: [[6, 9]], new: [[6, 9]] });
  });

  it("skips unrelated lines", () => {
    expect(intralineDiff("import x from 'y'", "return 42")).toBeNull();
  });

  it("pairs lines inside change blocks", () => {
    const text = (side: string, no: number) => (side === "old" ? { 4: "d", 40: "let x = 1" }[no] : { 4: "D", 5: "D2", 41: "let y = 1" }[no]) ?? "";
    const m = computeIntraline(file, text as never);
    expect(m.get("old:40")).toEqual([[4, 5]]);
    expect(m.get("new:41")).toEqual([[4, 5]]);
    expect(m.has("new:5")).toBe(false);
  });
});

describe("segments", () => {
  it("splits tokens at range edges", () => {
    const toks = [{ t: "const", l: "red" }, { t: " " }, { t: "foo", l: "blue" }];
    expect(segments("const foo", toks, [[4, 7]])).toEqual([
      { t: "cons", l: "red", hl: false },
      { t: "t", l: "red", hl: true },
      { t: " ", hl: true },
      { t: "f", l: "blue", hl: true },
      { t: "oo", l: "blue", hl: false },
    ]);
  });

  it("works without tokens or ranges", () => {
    expect(segments("abc", null, null)).toEqual([{ t: "abc", hl: false }]);
    expect(segments("abc", null, [[0, 1]])).toEqual([
      { t: "a", hl: true },
      { t: "bc", hl: false },
    ]);
  });
});
