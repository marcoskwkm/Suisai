import { describe, expect, it } from "vitest";
import { parsePatch } from "../git/parse";
import { DEFAULT_INSTRUCTIONS, fullJob, groupFiles, groupSections, groupStats, matchHunks, syncGuide, type Guide } from "./guide";
import { changeItems } from "./items";
import { renderMarkdown } from "./markdown";

function patch(files: Record<string, string[][]>): string {
  // Each file: a list of hunks, each a list of lines with their +/-/space prefix.
  let out = "";
  for (const [path, hunks] of Object.entries(files)) {
    out += `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`;
    let line = 1;
    for (const h of hunks) {
      const old = h.filter((l) => !l.startsWith("+")).length;
      const nw = h.filter((l) => !l.startsWith("-")).length;
      out += `@@ -${line},${old} +${line},${nw} @@\n${h.join("\n")}\n`;
      line += old + 10;
    }
  }
  return out;
}

const base = {
  "a.ts": [
    [" ctx", "-old a1", "+new a1"],
    [" ctx2", "+added a2"],
  ],
  "b.ts": [[" x", "-y", "+z"]],
};

function guideFor(files: typeof base): Guide {
  const items = changeItems(parsePatch(patch(files)));
  const job = fullJob(items, "claude");
  return job.apply({
    title: "T",
    overview: "O",
    groups: [
      { title: "First", explanation: "one", changes: ["c1", "c3"] },
      { title: "Second", explanation: "two", changes: ["c2"] },
    ],
  });
}

describe("change items", () => {
  it("keeps keys when hunks move", () => {
    const a = changeItems(parsePatch(patch(base)));
    const moved = parsePatch(patch(base).replace("@@ -1,2 +1,2 @@", "@@ -40,2 +40,2 @@"));
    expect(changeItems(moved).map((i) => i.key)).toEqual(a.map((i) => i.key));
  });

  it("gives identical hunks distinct keys", () => {
    const items = changeItems(parsePatch(patch({ "a.ts": [["+same"], ["+same"]] })));
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });
});

describe("full guides", () => {
  it("maps ids to items and collects leftovers", () => {
    const items = changeItems(parsePatch(patch(base)));
    const g = fullJob(items, "claude").apply({
      title: "T",
      overview: "O",
      groups: [{ title: "Only", explanation: "x", changes: ["c2", "c2", "c99"] }],
    });
    expect(g.groups.map((x) => x.title)).toEqual(["Only", "Other changes"]);
    expect(g.groups[0].keys).toEqual([items[1].key]);
    expect(g.groups[1].keys).toEqual([items[0].key, items[2].key]);
  });

  it("rejects answers without groups", () => {
    const items = changeItems(parsePatch(patch(base)));
    expect(() => fullJob(items, "claude").apply({ groups: [] })).toThrow();
  });
});

describe("custom instructions", () => {
  const custom = "Group by layer: backend first, then frontend. Write in French.";

  it("replace the default ones in a new guide's prompt", () => {
    const items = changeItems(parsePatch(patch(base)));
    expect(fullJob(items, "claude").prompt).toContain(DEFAULT_INSTRUCTIONS);
    const prompt = fullJob(items, "claude", custom).prompt;
    expect(prompt).toContain(custom);
    expect(prompt).not.toContain("How to group and order");
    // What Suisai depends on stays.
    expect(prompt).toContain("Put every change in exactly one group");
    expect(prompt).toContain("Answer only with JSON matching the schema");
    expect(prompt).toContain("### c1 · a.ts");
  });

  it("are used when updating a guide", () => {
    const g = guideFor(base);
    const changed = { ...base, "b.ts": [[" x", "-y", "+zz"]] };
    const s = syncGuide(g, changeItems(parsePatch(patch(changed))), "claude", custom);
    if (s.kind !== "update" || !s.job) throw new Error("expected an update job");
    expect(s.job.prompt).toContain(custom);
    expect(s.job.prompt).toContain("# How to answer");
  });

  it("fall back to the default when blank", () => {
    const items = changeItems(parsePatch(patch(base)));
    expect(fullJob(items, "claude", "   ").prompt).toContain(DEFAULT_INSTRUCTIONS);
  });
});

describe("syncing", () => {
  it("does nothing when the diff is the same", () => {
    const g = guideFor(base);
    expect(syncGuide(g, changeItems(parsePatch(patch(base))), "claude").kind).toBe("current");
  });

  it("drops a group whose changes were all removed, without the agent", () => {
    const g = guideFor(base);
    const items = changeItems(parsePatch(patch({ "a.ts": [base["a.ts"][0]], "b.ts": base["b.ts"] })));
    const s = syncGuide(g, items, "claude");
    expect(s.kind).toBe("update");
    if (s.kind !== "update") return;
    // "Second" only had a.ts's second hunk, so it is gone; "First" lost nothing.
    expect(s.guide.groups.map((x) => x.title)).toEqual(["First"]);
    expect(s.job).toBeNull();
  });

  it("asks the agent to refresh groups that lost changes", () => {
    const g = guideFor(base);
    // b.ts's change (in "First") is reverted.
    const items = changeItems(parsePatch(patch({ "a.ts": base["a.ts"] })));
    const s = syncGuide(g, items, "claude");
    if (s.kind !== "update" || !s.job) throw new Error("expected a refresh job");
    expect(s.guide.groups.map((x) => x.keys.length)).toEqual([1, 1]);
    expect(Object.values(s.guide.removed!)).toEqual([[expect.stringContaining("b.ts")]]);
    expect(s.job.prompt).toContain("changes were only removed");
    expect(s.job.prompt).toMatch(/Changes no longer in the diff[^\n]*\n- b\.ts/);

    const refreshed = s.job.apply({
      title: "",
      overview: "",
      groups: [
        { id: "g1", title: "", explanation: "one, without b", newChanges: [] },
        { id: "g2", title: "", explanation: "", newChanges: [] },
      ],
    });
    expect(refreshed.groups.map((x) => x.explanation)).toEqual(["one, without b", "two"]);
    expect(refreshed.removed).toBeUndefined();
    expect(syncGuide(refreshed, items, "claude").kind).toBe("current");
  });

  it("keeps asking until a removal is explained", () => {
    const g = guideFor(base);
    const items = changeItems(parsePatch(patch({ "a.ts": base["a.ts"] })));
    const s = syncGuide(g, items, "claude");
    if (s.kind !== "update") throw new Error("expected an update");
    // The refresh never ran (cancelled, failed or no agent): the next sync asks again.
    const again = syncGuide(s.guide, items, "claude");
    expect(again.kind === "update" && again.job?.prompt).toContain("- b.ts");
    // A later diff with new changes still mentions the old removal.
    const later = changeItems(parsePatch(patch({ "a.ts": [base["a.ts"][0], [" ctx2", "+added a2", "+more"]] })));
    const next = syncGuide(s.guide, later, "claude");
    expect(next.kind === "update" && next.job?.prompt).toContain("- b.ts");
  });

  it("asks only about new changes", () => {
    const g = guideFor(base);
    const changed = { ...base, "b.ts": [[" x", "-y", "+zz"]] };
    const items = changeItems(parsePatch(patch(changed)));
    const s = syncGuide(g, items, "claude");
    if (s.kind !== "update" || !s.job) throw new Error("expected an update job");
    expect(s.job.kind).toBe("update");
    expect(s.job.prompt).toContain("### n1 · b.ts");
    expect(s.job.prompt).not.toContain("### n2");
    // The old version of the hunk is listed as gone from its group.
    expect(s.job.prompt).toContain("Changes no longer in the diff");

    const updated = s.job.apply({
      title: "",
      overview: "",
      groups: [
        { id: "g2", title: "", explanation: "", newChanges: [] },
        { id: "g1", title: "", explanation: "one, updated", newChanges: ["n1"] },
      ],
    });
    expect(updated.title).toBe("T");
    expect(updated.groups.map((x) => x.title)).toEqual(["Second", "First"]);
    expect(updated.groups[1].explanation).toBe("one, updated");
    expect(updated.groups[1].keys).toContain(items[2].key);
    expect(updated.groups[1].id).toBe(g.groups[0].id);
  });

  it("keeps groups the agent forgot and places unassigned changes", () => {
    const g = guideFor(base);
    const changed = { ...base, "b.ts": [[" x", "-y", "+zz"]] };
    const s = syncGuide(g, changeItems(parsePatch(patch(changed))), "claude");
    if (s.kind !== "update" || !s.job) throw new Error("expected a job");
    const updated = s.job.apply({ title: "", overview: "", groups: [] });
    expect(updated.groups.map((x) => x.title)).toEqual(["First", "Second", "Other changes"]);
  });

  it("regenerates when most of the diff is new", () => {
    const g = guideFor(base);
    const items = changeItems(parsePatch(patch({ "c.ts": [["+1", "+2", "+3", "+4", "+5", "+6", "+7", "+8"]], "b.ts": base["b.ts"] })));
    const s = syncGuide(g, items, "claude");
    expect(s.kind === "update" && s.job?.kind).toBe("full");
  });

  it("discards a guide none of whose changes are in the diff", () => {
    const g = guideFor(base);
    const items = changeItems(parsePatch(patch({ "other.ts": [["+new"]] })));
    expect(syncGuide(g, items, "claude").kind).toBe("discard");
    expect(syncGuide(g, [], "claude").kind).toBe("discard");
  });

  it("shows the guide without what is gone while the agent works", () => {
    const g = guideFor(base);
    // a.ts's second hunk ("Second") is rewritten: until the agent answers, the
    // guide has no empty "Second" step and the new hunk is not in any step.
    const changed = { ...base, "a.ts": [base["a.ts"][0], [" ctx2", "+rewritten a2"]] };
    const items = changeItems(parsePatch(patch(changed)));
    const s = syncGuide(g, items, "claude");
    if (s.kind !== "update" || !s.job) throw new Error("expected an update job");
    expect(s.guide.groups.map((x) => x.title)).toEqual(["First"]);
    expect(s.guide.groups.flatMap((x) => x.keys)).not.toContain(items[1].key);
  });

  it("keeps the saved guide object when nothing changed", () => {
    const g = guideFor(base);
    const items = changeItems(parsePatch(patch(base)));
    expect(syncGuide(g, items, "claude")).toEqual({ kind: "current" });
  });
});

describe("sections", () => {
  it("shows each file with only the group's hunks", () => {
    const g = guideFor(base);
    const files = parsePatch(patch(base));
    const byKey = new Map(changeItems(files).map((i) => [i.key, i]));
    const shown = new Map(files.map((f) => [f.id, f]));
    const first = groupSections(g.groups[0], byKey, shown);
    expect(first.map((s) => [s.file.path, s.file.hunks.length])).toEqual([
      ["a.ts", 1],
      ["b.ts", 1],
    ]);
    expect(first[0].file.hunks[0].lines[1].text).toBe("old a1");
  });

  it("lists a group's files with their line counts", () => {
    const g = guideFor(base);
    const byKey = new Map(changeItems(parsePatch(patch(base))).map((i) => [i.key, i]));
    // "First" has a.ts's first hunk (+1 -1) and b.ts's hunk (+1 -1).
    expect(groupFiles(g.groups[0], byKey).map((f) => [f.file.path, f.additions, f.deletions])).toEqual([
      ["a.ts", 1, 1],
      ["b.ts", 1, 1],
    ]);
    expect(groupStats(g.groups[0], byKey)).toEqual({ additions: 2, deletions: 2, files: 2 });
  });

  it("matches whitespace-hidden hunks to full ones by overlap", () => {
    const h = (newStart: number, newLines: number) => ({ oldStart: newStart, oldLines: newLines, newStart, newLines, header: "", lines: [] });
    expect(matchHunks([h(1, 5), h(20, 5)], [h(21, 2), h(2, 1), h(50, 1)])).toEqual([1, 0, 1]);
  });
});

describe("markdown", () => {
  it("escapes HTML", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });

  it("turns mermaid blocks into escaped diagram placeholders", () => {
    const html = renderMarkdown('Flow:\n\n```mermaid\nflowchart LR\n  A["<b>x</b>"] --> B\n```\n\nAfter.');
    const source = 'flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;] --&gt; B';
    expect(html).toBe(
      `<p>Flow:</p><div class="diagram" data-diagram="${source}"><pre><code>${source}</code></pre></div><p>After.</p>`,
    );
    // Other languages stay code blocks.
    expect(renderMarkdown("```ts\nlet a = 1;\n```")).toBe("<pre><code>let a = 1;</code></pre>");
  });

  it("renders lists, code and emphasis", () => {
    expect(renderMarkdown("Uses `a<b>` and **bold**.\n\n- one\n- *two*")).toBe(
      "<p>Uses <code>a&lt;b&gt;</code> and <strong>bold</strong>.</p><ul><li>one</li><li><em>two</em></li></ul>",
    );
  });
});
