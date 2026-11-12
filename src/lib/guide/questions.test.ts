import { describe, expect, it } from "vitest";
import { parsePatch } from "../git/parse";
import type { Guide } from "./guide";
import { lineKeys, linesLabel, parseAnswer, questionPrompt, type Thread } from "./questions";
import type { DiffLine } from "../types";

const file = parsePatch(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@ function f() {
 const a = 1;
-const b = 2;
+const b = 3;
 return a + b;
`)[0];

const lines: DiffLine[] = file.hunks[0].lines.slice(1, 3);

const guide: Guide = {
  version: 1,
  agent: "claude",
  title: "Change b",
  overview: "Makes b bigger.",
  groups: [
    { id: "g-a", title: "Setup", explanation: "Sets things up.", keys: ["k1"] },
    { id: "g-b", title: "Bump b", explanation: "Bumps `b`.", keys: ["k2"] },
  ],
  labels: {},
  createdAt: 1,
  updatedAt: 1,
};

function thread(exchanges: Thread["exchanges"]): Thread {
  return { id: "t", guide: 1, groupId: "g-b", file, lines, exchanges, startedAt: null, error: null };
}

describe("selected lines", () => {
  it("are labeled with new line numbers, or old ones when only removed", () => {
    expect(linesLabel([lines[1]])).toBe("Line 11");
    expect(linesLabel([file.hunks[0].lines[0], lines[1], file.hunks[0].lines[3]])).toBe("Lines 10–12");
    expect(linesLabel([lines[0]])).toBe("Old line 11");
    expect(linesLabel(file.hunks[0].lines)).toBe("Old line 11, lines 10–12");
  });

  it("are keyed on both sides", () => {
    expect([...lineKeys(file.hunks[0].lines.slice(0, 2))].sort()).toEqual(["new:10", "old:10", "old:11"]);
  });
});

describe("question prompts", () => {
  it("show the step, its diff, the selection and the question", () => {
    const p = questionPrompt(guide, guide.groups[1], thread([{ question: "Why 3?", answer: null }]));
    expect(p).toContain("# Step 2 of 2: Bump b");
    expect(p).toContain("Bumps `b`.");
    expect(p).toContain("@@ -10,3 +10,3 @@ function f() {\n const a = 1;\n-const b = 2;");
    expect(p).toContain("```diff\n11 -const b = 2;\n11 +const b = 3;\n```");
    expect(p).toContain("# Question\n\nWhy 3?");
    expect(p).not.toContain("# Conversation so far");
  });

  it("carry the earlier questions and answers of a thread", () => {
    const p = questionPrompt(
      guide,
      guide.groups[1],
      thread([
        { question: "Why 3?", answer: "Because of `c`." },
        { question: "What is c?", answer: null },
      ]),
    );
    expect(p).toContain("# Conversation so far\n\nQuestion: Why 3?\n\nAnswer: Because of `c`.");
    expect(p).toContain("# Question\n\nWhat is c?");
  });
});

describe("answers", () => {
  it("are read from the agent's JSON", () => {
    expect(parseAnswer({ answer: "  Yes.\n" })).toBe("Yes.");
    expect(() => parseAnswer({ answer: " " })).toThrow();
    expect(() => parseAnswer("Yes")).toThrow();
  });
});
