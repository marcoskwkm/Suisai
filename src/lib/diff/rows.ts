import type { DiffLine, FileDiff, Hunk, LineType, Side, ViewMode } from "../types";
import { intralineDiff, type Ranges } from "./intraline";

/** How many hidden lines one click on an expander reveals. */
export const EXPAND_STEP = 20;

export interface Cell {
  type: LineType;
  no: number;
}

export type Row =
  | { kind: "line"; type: LineType; oldNo: number | null; newNo: number | null }
  | { kind: "pair"; left: Cell | null; right: Cell | null }
  | {
      kind: "expander";
      gap: number;
      header: string | null;
      /** Hidden lines left in this gap. */
      remaining: number;
      /** Can reveal lines above (closest to the next hunk). */
      up: boolean;
      /** Can reveal lines below (closest to the previous hunk). */
      down: boolean;
    };

/** Unchanged lines before hunk `index` (or after the last hunk, if index === hunks.length). */
export interface Gap {
  index: number;
  oldStart: number;
  newStart: number;
  /** null when the size is unknown (no file contents for the trailing gap). */
  size: number | null;
}

/** Lines revealed from the top (after the previous hunk) and bottom (before the next hunk). */
export interface Expansion {
  top: number;
  bottom: number;
}

export type Expansions = Record<number, Expansion>;

const firstLine = (start: number, count: number) => (count === 0 ? start + 1 : start);
const lastLine = (start: number, count: number) => (count === 0 ? start : start + count - 1);

export function computeGaps(hunks: Hunk[], oldCount: number | null, newCount: number | null): Gap[] {
  const gaps: Gap[] = [];
  let prevOld = 0;
  let prevNew = 0;
  for (let i = 0; i <= hunks.length; i++) {
    const h = hunks[i];
    let size: number | null;
    if (h) {
      size = firstLine(h.oldStart, h.oldLines) - prevOld - 1;
    } else if (oldCount !== null) {
      size = oldCount - prevOld;
    } else if (newCount !== null) {
      size = newCount - prevNew;
    } else {
      size = null;
    }
    gaps.push({ index: i, oldStart: prevOld + 1, newStart: prevNew + 1, size: size === null ? null : Math.max(0, size) });
    if (h) {
      prevOld = lastLine(h.oldStart, h.oldLines);
      prevNew = lastLine(h.newStart, h.newLines);
    }
  }
  return gaps;
}

function pushHunkLines(rows: Row[], lines: DiffLine[], view: ViewMode) {
  if (view === "unified") {
    for (const l of lines) rows.push({ kind: "line", type: l.type, oldNo: l.oldNo, newNo: l.newNo });
    return;
  }
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "context") {
      rows.push({ kind: "pair", left: { type: "context", no: l.oldNo! }, right: { type: "context", no: l.newNo! } });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && lines[i].type !== "context") {
      if (lines[i].type === "del") dels.push(lines[i].oldNo!);
      else adds.push(lines[i].newNo!);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({
        kind: "pair",
        left: k < dels.length ? { type: "del", no: dels[k] } : null,
        right: k < adds.length ? { type: "add", no: adds[k] } : null,
      });
    }
  }
}

function pushContext(rows: Row[], oldNo: number, newNo: number, view: ViewMode) {
  if (view === "unified") rows.push({ kind: "line", type: "context", oldNo, newNo });
  else rows.push({ kind: "pair", left: { type: "context", no: oldNo }, right: { type: "context", no: newNo } });
}

export function buildRows(file: FileDiff, view: ViewMode, gaps: Gap[], expansions: Expansions, canExpand: boolean): Row[] {
  const rows: Row[] = [];
  const n = file.hunks.length;
  if (n === 0) return rows;

  for (const gap of gaps) {
    const i = gap.index;
    const header = i < n ? file.hunks[i].header : null;
    if (!canExpand || gap.size === null) {
      if (header) rows.push({ kind: "expander", gap: i, header, remaining: 0, up: false, down: false });
    } else {
      const size = gap.size;
      const exp = expansions[i] ?? { top: 0, bottom: 0 };
      // The first gap only grows upwards from the first hunk; the last one only downwards.
      const total = exp.top + exp.bottom;
      const top = i === 0 ? 0 : i === n ? Math.min(total, size) : Math.min(exp.top, size);
      const bottom = i === 0 ? Math.min(total, size) : i === n ? 0 : Math.min(exp.bottom, size - top);
      const remaining = size - top - bottom;

      for (let k = 0; k < top; k++) pushContext(rows, gap.oldStart + k, gap.newStart + k, view);
      if (remaining > 0 || (i === 0 && size === 0)) {
        const more = remaining > 0;
        rows.push({ kind: "expander", gap: i, header, remaining, up: more && i < n, down: more && i > 0 });
      }
      for (let k = size - bottom; k < size; k++) pushContext(rows, gap.oldStart + k, gap.newStart + k, view);
    }
    if (i < n) pushHunkLines(rows, file.hunks[i].lines, view);
  }
  return rows;
}

/** Applies a click on an expander. `all` reveals the whole gap. */
export function expand(expansions: Expansions, gap: Gap, direction: "up" | "down" | "all"): Expansions {
  const cur = expansions[gap.index] ?? { top: 0, bottom: 0 };
  const size = gap.size ?? 0;
  let next: Expansion;
  if (direction === "all") next = { top: size, bottom: 0 };
  else if (direction === "up") next = { ...cur, bottom: cur.bottom + EXPAND_STEP };
  else next = { ...cur, top: cur.top + EXPAND_STEP };
  return { ...expansions, [gap.index]: next };
}

/** Indices of rows where a block of changes starts (for next/previous change). */
export function changeStarts(rows: Row[]): number[] {
  const out: number[] = [];
  let inChange = false;
  rows.forEach((r, i) => {
    const changed = r.kind === "line" ? r.type !== "context" : r.kind === "pair" ? r.left?.type !== "context" : false;
    if (changed && !inChange) out.push(i);
    inChange = changed;
  });
  return out;
}

export type LineKey = `${Side}:${number}`;

/**
 * Word-level highlights for each removed/added line paired up within a block
 * of changes. Keyed by `old:<n>` / `new:<n>`.
 */
export function computeIntraline(file: FileDiff, text: (side: Side, no: number) => string): Map<LineKey, Ranges> {
  const out = new Map<LineKey, Ranges>();
  for (const h of file.hunks) {
    let i = 0;
    while (i < h.lines.length) {
      if (h.lines[i].type === "context") {
        i++;
        continue;
      }
      const dels: number[] = [];
      const adds: number[] = [];
      while (i < h.lines.length && h.lines[i].type !== "context") {
        const l = h.lines[i++];
        if (l.type === "del") dels.push(l.oldNo!);
        else adds.push(l.newNo!);
      }
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const r = intralineDiff(text("old", dels[k]), text("new", adds[k]));
        if (r) {
          out.set(`old:${dels[k]}`, r.old);
          out.set(`new:${adds[k]}`, r.new);
        }
      }
    }
  }
  return out;
}
