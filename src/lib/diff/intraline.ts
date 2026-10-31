import { diffArrays } from "diff";

/** Character ranges [start, end) to emphasize within a line. */
export type Ranges = [number, number][];

const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const MAX_LINE = 1000;
/** Below this share of unchanged characters, the lines are unrelated: skip. */
const MIN_SIMILARITY = 0.35;

function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

function push(ranges: Ranges, start: number, end: number) {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === start) last[1] = end;
  else ranges.push([start, end]);
}

/**
 * Word-level diff between a removed and an added line, like GitHub's darker
 * highlight. Returns null when the lines are too different to be useful.
 */
export function intralineDiff(oldText: string, newText: string): { old: Ranges; new: Ranges } | null {
  if (oldText === newText) return null;
  if (oldText.length > MAX_LINE || newText.length > MAX_LINE) return null;

  const changes = diffArrays(tokenize(oldText), tokenize(newText));
  const oldRanges: Ranges = [];
  const newRanges: Ranges = [];
  let o = 0;
  let n = 0;
  let same = 0;
  for (const c of changes) {
    const len = c.value.reduce((sum, t) => sum + t.length, 0);
    if (c.added) {
      push(newRanges, n, n + len);
      n += len;
    } else if (c.removed) {
      push(oldRanges, o, o + len);
      o += len;
    } else {
      same += len;
      o += len;
      n += len;
    }
  }
  const longest = Math.max(oldText.trim().length, newText.trim().length, 1);
  if (same / longest < MIN_SIMILARITY && oldText.trim() !== newText.trim()) return null;
  return { old: oldRanges, new: newRanges };
}
