// Review guides: changes grouped by purpose, in reading order, each group with
// an explanation. Written by an AI agent, then kept in sync with the diff by
// asking the agent only about the changes it has not seen.

import type { FileDiff, Hunk } from "../types";
import { describe, itemSize, renderItem, type ChangeItem } from "./items";

export type AgentKind = "claude" | "codex";

export interface GuideGroup {
  id: string;
  title: string;
  /** Markdown. */
  explanation: string;
  /** Change item keys, in the order the agent listed them. */
  keys: string[];
}

export interface Guide {
  version: 1;
  agent: AgentKind;
  title: string;
  overview: string;
  groups: GuideGroup[];
  /** One-line descriptions of the items, to tell the agent what was removed. */
  labels: Record<string, string>;
  /**
   * Changes removed from each group (by group id, as descriptions) that the
   * agent has not yet updated the group's explanation for.
   */
  removed?: Record<string, string[]>;
  createdAt: number;
  updatedAt: number;
}

/** A request for the agent: prompt, the schema of its answer, and how to apply it. */
export interface AgentJob {
  kind: "full" | "update";
  prompt: string;
  schema: object;
  apply: (answer: unknown) => Guide;
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** When more than this share of the diff is new, regenerating gives a better guide than patching. */
const REGENERATE_ABOVE = 0.6;

// ---- prompts ----

/**
 * How to group, order and write, as the user can customize it in the agent
 * settings. The rest of the prompt (change ids, the answer's format, how to
 * update a guide) is fixed, because Suisai depends on it.
 */
export const DEFAULT_INSTRUCTIONS = `How to group and order:
- Group changes by purpose (one feature, refactor, fix or concern per group), not by file. One file's changes can be split across groups.
- Order the groups so that reading them in sequence explains the whole change: put foundations first (types, data models, schemas, config, core logic) and the code that uses them after. Put tests right after the code they test, unless they are a group of their own. Put incidental changes (formatting, renames, generated files, lockfiles) last.
- Typical diffs need 2 to 8 groups. A group can hold a single change. Avoid a vague "miscellaneous" group when a better home exists.

How to write:
- title: a short phrase (at most 8 words) naming what the group does, e.g. "Parse hunks into change items".
- explanation: Markdown, 1 to 3 short paragraphs or a bullet list. Explain the purpose and intention of the changes, how they connect to the earlier groups, and anything a reviewer should check (edge cases, risks, behavior changes). Do not restate the code line by line. Refer to identifiers and files in \`backticks\`.
- Diagrams and charts: the guide is shown in an app that draws Mermaid diagrams. Add one when it shows something prose cannot show as quickly: branching logic or a state machine, several components calling each other, a pipeline with more than a few stages, dependencies between modules or types, or numbers worth comparing. A diagram must add information or clarity, not repeat the text: do not draw a straight chain of two or three steps, a single call, a list of files or functions, or a chart of one or two numbers, and do not add one just because a group is large. When unsure, leave it out. Put it in that group's explanation as a fenced code block with the language \`mermaid\`, after a sentence that introduces it. Use \`flowchart\`, \`sequenceDiagram\`, \`classDiagram\`, \`stateDiagram-v2\` or \`erDiagram\` for structure and behavior, and \`pie\` or \`xychart-beta\` for charts. Explanations are shown in a column about 750 pixels wide, so prefer top-down layouts (\`flowchart TD\`) to long left-to-right chains, and keep labels short. Keep each one small (about 15 nodes at most), name things as the code does, and put labels with spaces or punctuation in double quotes, e.g. \`A["parsePatch()"] --> B["FileDiff[]"]\`. Never add one to simple steps (docs, renames, small fixes) or to the overview.
- The guide's title: at most 8 words. Its overview: 1 to 3 sentences on what the whole change does.`;

/** The instructions to use, followed by the fixed rules every prompt needs. */
function guidelines(custom: string | null | undefined): string {
  return `${custom?.trim() || DEFAULT_INSTRUCTIONS}

The repository is in the current directory. You may read a few files for context when the diff alone is unclear, but keep it brief and do not modify anything. Answer only with JSON matching the schema.`;
}

const str = { type: "string" } as const;
const strArray = { type: "array", items: str } as const;
const obj = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const FULL_SCHEMA = obj({
  title: str,
  overview: str,
  groups: { type: "array", items: obj({ title: str, explanation: str, changes: strArray }) },
});

const UPDATE_SCHEMA = obj({
  title: str,
  overview: str,
  groups: { type: "array", items: obj({ id: str, title: str, explanation: str, newChanges: strArray }) },
});

/** Shortens hunks so the prompt stays a reasonable size. */
function renderAll(entries: [string, ChangeItem][]): string {
  const BUDGET = 400_000;
  let text = "";
  for (const maxLines of [400, 120, 40, 10]) {
    text = entries.map(([id, it]) => renderItem(id, it, maxLines)).join("\n\n");
    if (text.length <= BUDGET) break;
  }
  return text;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const OTHER_TITLE = "Other changes";
const OTHER_TEXT = "Changes the guide did not place in a group.";

/** Puts keys the agent left out into a trailing group. */
function placeLeftovers(groups: GuideGroup[], leftovers: string[]) {
  if (leftovers.length === 0) return;
  const other = groups.find((g) => g.title === OTHER_TITLE);
  if (other) other.keys.push(...leftovers);
  else groups.push({ id: newId(), title: OTHER_TITLE, explanation: OTHER_TEXT, keys: leftovers });
}

function labelsFor(items: ChangeItem[]): Record<string, string> {
  return Object.fromEntries(items.map((it) => [it.key, describe(it)]));
}

/** A job that writes a guide from scratch. */
export function fullJob(items: ChangeItem[], agent: AgentKind, instructions?: string | null): AgentJob {
  const ids = new Map<string, string>();
  const entries = items.map((it, i): [string, ChangeItem] => {
    ids.set(`c${i + 1}`, it.key);
    return [`c${i + 1}`, it];
  });
  const prompt = `You are helping a developer review a code change. Write a review guide for the diff below: split its changes into groups and explain each group, so that reading the groups in order explains the whole change.

Each change is a hunk (or a whole file) with an id like c1. Put every change in exactly one group. Also give the guide a title and an overview.

${guidelines(instructions)}

# Changes

${renderAll(entries)}`;

  return {
    kind: "full",
    prompt,
    schema: FULL_SCHEMA,
    apply(answer) {
      const a = asRecord(answer);
      const used = new Set<string>();
      const groups: GuideGroup[] = [];
      for (const g of asArray(a.groups)) {
        const r = asRecord(g);
        const keys: string[] = [];
        for (const id of asArray(r.changes)) {
          const key = ids.get(asString(id));
          if (key && !used.has(key)) {
            used.add(key);
            keys.push(key);
          }
        }
        if (keys.length) groups.push({ id: newId(), title: asString(r.title) || "Untitled", explanation: asString(r.explanation), keys });
      }
      if (groups.length === 0) throw new Error("The agent's answer had no groups.");
      placeLeftovers(
        groups,
        items.filter((it) => !used.has(it.key)).map((it) => it.key),
      );
      const now = Date.now();
      return {
        version: 1,
        agent,
        title: asString(a.title),
        overview: asString(a.overview),
        groups,
        labels: labelsFor(items),
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}

/** What it takes to bring a guide up to date with the diff. */
export type Sync =
  | { kind: "current" }
  /** None of the guide's changes are in the diff: it was written for other changes. */
  | { kind: "discard" }
  /**
   * The guide without the changes that are gone, to show right away, and
   * the agent job that brings it fully up to date (null if none is needed).
   */
  | { kind: "update"; guide: Guide; job: AgentJob | null };

/**
 * Compares a guide with the diff's items. Items that are still there keep
 * their group; the agent is only asked about new or changed ones, and about
 * the groups that lost changes.
 */
export function syncGuide(guide: Guide, items: ChangeItem[], agent: AgentKind, instructions?: string | null): Sync {
  const byKey = new Map(items.map((it) => [it.key, it]));
  const known = new Set(guide.groups.flatMap((g) => g.keys));
  const fresh = items.filter((it) => !known.has(it.key));

  const kept = guide.groups.map((g) => ({ ...g, keys: g.keys.filter((k) => byKey.has(k)) }));
  const remaining = kept.filter((g) => g.keys.length);
  if (remaining.length === 0) return { kind: "discard" };

  const removedNow = remaining.length < guide.groups.length || kept.some((g, i) => g.keys.length < guide.groups[i].keys.length);
  // Descriptions of what each remaining group lost, including earlier removals not yet explained.
  const lost = new Map<string, string[]>();
  for (const g of guide.groups) {
    const gone = [
      ...(guide.removed?.[g.id] ?? []),
      ...g.keys.filter((k) => !byKey.has(k)).map((k) => guide.labels[k] ?? "(unknown change)"),
    ];
    if (gone.length && g.keys.some((k) => byKey.has(k))) lost.set(g.id, gone);
  }
  if (fresh.length === 0 && !removedNow && lost.size === 0) return { kind: "current" };

  const pruned: Guide = {
    ...guide,
    groups: remaining,
    removed: lost.size ? Object.fromEntries(lost) : undefined,
    updatedAt: removedNow ? Date.now() : guide.updatedAt,
  };
  if (fresh.length === 0 && lost.size === 0) return { kind: "update", guide: pruned, job: null };

  const total = items.reduce((n, it) => n + itemSize(it), 0);
  const added = fresh.reduce((n, it) => n + itemSize(it), 0);
  const job =
    added > REGENERATE_ABOVE * total
      ? fullJob(items, agent, instructions)
      : updateJob(pruned, remaining, lost, fresh, items, agent, instructions);
  return { kind: "update", guide: pruned, job };
}

function updateJob(
  guide: Guide,
  kept: GuideGroup[],
  /** Descriptions of the changes each group lost. */
  lost: Map<string, string[]>,
  fresh: ChangeItem[],
  items: ChangeItem[],
  agent: AgentKind,
  instructions: string | null | undefined,
): AgentJob {
  const byKey = new Map(items.map((it) => [it.key, it]));
  // Short ids in the prompt: g1… for groups, n1… for new changes.
  const groupIds = new Map(kept.map((g, i) => [`g${i + 1}`, g.id]));
  const newIds = new Map(fresh.map((it, i) => [`n${i + 1}`, it.key]));

  const outline = kept
    .map((g, i) => {
      const lines = [`## g${i + 1}: ${g.title}`, "", g.explanation, "", "Changes still in the diff:"];
      lines.push(...(g.keys.length ? g.keys.map((k) => `- ${describe(byKey.get(k)!)}`) : ["- (none)"]));
      const gone = lost.get(g.id) ?? [];
      if (gone.length) {
        lines.push("", "Changes no longer in the diff (reverted or rewritten):");
        lines.push(...gone.map((label) => `- ${label}`));
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const newSection = fresh.length
    ? `# New or rewritten changes

Each one has an id like n1. Only these are shown in full; the changes listed under the groups above are unchanged.

${renderAll(fresh.map((it, i) => [`n${i + 1}`, it]))}`
    : `# New or rewritten changes

None: changes were only removed. Update the explanations of the groups that lost changes so they describe only what is still in the diff, and leave newChanges empty.`;

  const prompt = `You are helping a developer review a code change. Earlier, you wrote a review guide for this diff, grouping its changes and explaining each group. The diff has changed since then. Update the guide to match it, changing as little as needed.

${guidelines(instructions)}

# Current guide

Title: ${guide.title}
Overview: ${guide.overview}

${outline}

${newSection}

# How to answer

Return every group of the updated guide, in reading order:
- For an existing group, set id to its id (g1, g2…). Set title and explanation to empty strings to keep them as they are. Rewrite them when they no longer match the group: it lost or gained changes, or its purpose changed. A group that lost changes almost always needs its explanation rewritten, unless the explanation never mentioned them. Explanations describe the diff as it is now: do not mention what was removed or how the diff changed.
- For a new group, set id to an empty string and write its title and explanation.
- List in newChanges the new changes (n1, n2…) that go in that group. Every new change must be in exactly one group. Changes already in a group stay there.
- A group that has no changes left may be omitted.
Set title and overview to empty strings to keep the guide's, or rewrite them if they no longer describe the diff.`;

  return {
    kind: "update",
    prompt,
    schema: UPDATE_SCHEMA,
    apply(answer) {
      const a = asRecord(answer);
      const keptById = new Map(kept.map((g) => [g.id, g]));
      const placed = new Set<string>();
      const usedGroups = new Set<string>();
      const groups: GuideGroup[] = [];
      for (const g of asArray(a.groups)) {
        const r = asRecord(g);
        const keys: string[] = [];
        for (const id of asArray(r.newChanges)) {
          const key = newIds.get(asString(id));
          if (key && !placed.has(key)) {
            placed.add(key);
            keys.push(key);
          }
        }
        const existing = keptById.get(groupIds.get(asString(r.id)) ?? "");
        if (existing && !usedGroups.has(existing.id)) {
          usedGroups.add(existing.id);
          groups.push({
            id: existing.id,
            title: asString(r.title) || existing.title,
            explanation: asString(r.explanation) || existing.explanation,
            keys: [...existing.keys, ...keys],
          });
        } else if (keys.length) {
          groups.push({ id: newId(), title: asString(r.title) || "Untitled", explanation: asString(r.explanation), keys });
        }
      }
      // Groups the agent forgot keep their changes, at the end.
      for (const g of kept) if (!usedGroups.has(g.id)) groups.push(g);
      placeLeftovers(
        groups,
        fresh.filter((it) => !placed.has(it.key)).map((it) => it.key),
      );
      return {
        ...guide,
        agent,
        title: asString(a.title) || guide.title,
        overview: asString(a.overview) || guide.overview,
        groups: groups.filter((g) => g.keys.length),
        labels: labelsFor(items),
        removed: undefined,
        updatedAt: Date.now(),
      };
    },
  };
}

// ---- showing a group ----

/** One file's part of a group: the file with only that group's hunks. */
export interface Section {
  file: FileDiff;
  /** The whole file is the change (binary, rename, mode change, empty file). */
  whole: boolean;
}

/** Lines a hunk covers on one side, as [start, end). */
function span(start: number, count: number): [number, number] {
  return count === 0 ? [start, start + 1] : [start, start + count];
}
const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/**
 * For each hunk shown (e.g. from `git diff -w`), the hunk of the full diff it
 * overlaps most. Guides are made from the full diff.
 */
export function matchHunks(full: Hunk[], shown: Hunk[]): number[] {
  return shown.map((s) => {
    let best = 0;
    let bestScore = -1;
    full.forEach((f, i) => {
      const score =
        overlap(span(s.oldStart, s.oldLines), span(f.oldStart, f.oldLines)) +
        overlap(span(s.newStart, s.newLines), span(f.newStart, f.newLines));
      const distance = Math.abs(s.newStart - f.newStart);
      // Without overlap, the nearest hunk wins.
      const value = score > 0 ? score * 1e9 : -distance;
      if (bestScore === -1 || value > bestScore) {
        best = i;
        bestScore = value;
      }
    });
    return best;
  });
}

/**
 * The files of a group, in the order the agent listed its changes, each with
 * only the group's hunks. `shownFiles` are the files on screen (they differ
 * from the items' files when whitespace changes are hidden).
 */
export function groupSections(group: GuideGroup, byKey: Map<string, ChangeItem>, shownFiles: Map<string, FileDiff>): Section[] {
  const perFile = new Map<string, { full: FileDiff; hunks: Set<number>; whole: boolean }>();
  for (const key of group.keys) {
    const it = byKey.get(key);
    if (!it) continue;
    let entry = perFile.get(it.file.id);
    if (!entry) perFile.set(it.file.id, (entry = { full: it.file, hunks: new Set(), whole: false }));
    if (it.hunk === null) entry.whole = true;
    else entry.hunks.add(it.hunk);
  }
  const sections: Section[] = [];
  for (const { full, hunks, whole } of perFile.values()) {
    if (whole) {
      sections.push({ file: full, whole: true });
      continue;
    }
    const shown = shownFiles.get(full.id) ?? full;
    let picked: Hunk[];
    if (shown.hunks === full.hunks) {
      picked = full.hunks.filter((_, i) => hunks.has(i));
    } else {
      const owners = matchHunks(full.hunks, shown.hunks);
      picked = shown.hunks.filter((_, i) => hunks.has(owners[i]));
    }
    if (picked.length === 0) continue;
    sections.push({ file: { ...shown, hunks: picked }, whole: false });
  }
  return sections;
}

/** A file in a group, with the lines the group's changes add and remove in it. */
export interface GroupFile {
  file: FileDiff;
  additions: number;
  deletions: number;
}

/** The files of a group, in the order the agent listed its changes. */
export function groupFiles(group: GuideGroup, byKey: Map<string, ChangeItem>): GroupFile[] {
  const files = new Map<string, GroupFile>();
  for (const k of group.keys) {
    const it = byKey.get(k);
    if (!it) continue;
    let f = files.get(it.file.id);
    if (!f) files.set(it.file.id, (f = { file: it.file, additions: 0, deletions: 0 }));
    f.additions += it.additions;
    f.deletions += it.deletions;
  }
  return [...files.values()];
}

/** Lines added and removed in a group, and how many files it touches. */
export function groupStats(group: GuideGroup, byKey: Map<string, ChangeItem>) {
  const files = groupFiles(group, byKey);
  return {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files: files.length,
  };
}

/** Parses a cached guide, or null if it is unusable. */
export function parseGuide(text: string | null): Guide | null {
  if (!text) return null;
  try {
    const g = JSON.parse(text) as Guide;
    return g && g.version === 1 && Array.isArray(g.groups) ? g : null;
  } catch {
    return null;
  }
}

