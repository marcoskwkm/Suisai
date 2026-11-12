// Questions about lines of a guide's diff: the reader selects lines in a
// step, asks the agent about them, and can follow up. Each question is a
// one-off run of the agent, so the prompt carries the conversation so far.

import type { DiffLine, FileDiff } from "../types";
import type { Guide, GuideGroup } from "./guide";
import { SIGN } from "./items";

export interface Exchange {
  question: string;
  /** Markdown; null until the agent answers. */
  answer: string | null;
}

/** Questions about one selection of lines. */
export interface Thread {
  id: string;
  /** The guide (by createdAt) and step (by group id) it was asked in. */
  guide: number;
  groupId: string;
  /** The step's part of the file: only the step's hunks. */
  file: FileDiff;
  lines: DiffLine[];
  /** Empty while the first question is being written. */
  exchanges: Exchange[];
  /** When the agent started on the last question; null when it is not working. */
  startedAt: number | null;
  error: string | null;
}

/** Where to find a line among a diff's lines: by its new number, or its old one when removed. */
export const lineNo = (l: DiffLine) => l.newNo ?? l.oldNo!;

/**
 * E.g. "Line 4", "Lines 41–42", "Old lines 10–12" when only removed lines are
 * selected, or "Old lines 94–95, line 94" for removed and added ones.
 */
export function linesLabel(lines: DiffLine[]): string {
  const range = (word: string, nums: number[]) => {
    const from = Math.min(...nums);
    const to = Math.max(...nums);
    return from === to ? `${word} ${from}` : `${word}s ${from}–${to}`;
  };
  const removed = lines.flatMap((l) => (l.type === "del" ? [l.oldNo!] : []));
  const rest = lines.flatMap((l) => (l.type === "del" ? [] : [l.newNo!]));
  if (!removed.length) return range("Line", rest);
  if (!rest.length) return range("Old line", removed);
  return `${range("Old line", removed)}, ${range("line", rest)}`;
}

/** Keys of the lines (as `old:12`, `new:41`), to highlight them in a diff. */
export function lineKeys(lines: DiffLine[]): Set<string> {
  const keys = new Set<string>();
  for (const l of lines) {
    if (l.oldNo !== null) keys.add(`old:${l.oldNo}`);
    if (l.newNo !== null) keys.add(`new:${l.newNo}`);
  }
  return keys;
}

/** Hunks longer than this are shortened in the prompt; the selected lines are always shown in full. */
const MAX_HUNK_LINES = 300;

function renderHunks(file: FileDiff): string {
  return file.hunks
    .map((h) => {
      const shown = h.lines.slice(0, MAX_HUNK_LINES).map((l) => SIGN[l.type] + l.text);
      if (h.lines.length > MAX_HUNK_LINES) shown.push(`… ${h.lines.length - MAX_HUNK_LINES} more lines`);
      return [h.header, ...shown].join("\n");
    })
    .join("\n");
}

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
} as const;

/** The prompt for the thread's last question. */
export function questionPrompt(guide: Guide, group: GuideGroup, thread: Thread): string {
  const step = guide.groups.indexOf(group) + 1;
  const path = thread.file.path;
  const width = String(Math.max(...thread.lines.map(lineNo))).length;
  const selected = thread.lines.map((l) => `${String(lineNo(l)).padStart(width)} ${SIGN[l.type]}${l.text}`).join("\n");
  const earlier = thread.exchanges.slice(0, -1);
  const question = thread.exchanges.at(-1)!.question;
  const conversation = earlier.length
    ? `# Conversation so far

${earlier.map((e) => `Question: ${e.question}\n\nAnswer: ${e.answer ?? "(none)"}`).join("\n\n---\n\n")}

`
    : "";

  return `You are helping a developer review a code change. They are reading a review guide for the diff, which groups its changes into steps, and have a question about some lines of it.

# The guide

Title: ${guide.title}
Overview: ${guide.overview}

# Step ${step} of ${guide.groups.length}: ${group.title}

${group.explanation}

# This step's changes to \`${path}\`

\`\`\`diff
${renderHunks(thread.file)}
\`\`\`

# The selected lines

From \`${path}\`, numbered as in the new file (removed lines as in the old file), with the diff's +/- signs:

\`\`\`diff
${selected}
\`\`\`

${conversation}# Question

${question}

# How to answer

Answer the question about the selected lines. The repository is in the current directory: read files when the diff alone does not answer the question, but keep it brief and do not modify anything. Write the answer in Markdown: be direct and concise, refer to identifiers and files in \`backticks\`, and add a Mermaid diagram (a fenced code block with the language \`mermaid\`) only when it shows something prose cannot. Answer only with JSON matching the schema.`;
}

/** The answer's text, from the agent's JSON. */
export function parseAnswer(answer: unknown): string {
  const text = answer && typeof answer === "object" ? (answer as Record<string, unknown>).answer : null;
  if (typeof text !== "string" || !text.trim()) throw new Error("The agent did not answer.");
  return text.trim();
}
