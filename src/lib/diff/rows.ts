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
      /** Hunks not shown (see Gap.hunks) that the next click reveals. */
      reveals: Hunk[];
    };

/** Unchanged lines before hunk `index` (or after the last hunk, if index === hunks.length). */
export interface Gap {
  index: number;
  oldStart: number;
  newStart: number;
  /**
   * Lines in the gap, counting each of `hunks` as its lines; null when unknown
   * (no file contents for the trailing gap).
   */
  size: number | null;
  /**
   * Hunks not shown that lie inside the gap (e.g. other steps of a guide).
   * Expanding stops at each and then reveals it whole.
   */
  hunks?: Hunk[];
}

/** A part of a gap: unchanged lines, or a hunk not shown. */
type GapPart = { kind: "context"; oldStart: number; newStart: number; size: number } | { kind: "hunk"; hunk: Hunk; size: number };

/** Lines revealed from the top (after the previous hunk) and bottom (before the next hunk). */
export interface Expansion {
  top: number;
  bottom: number;
}

export type Expansions = Record<number, Expansion>;

const firstLine = (start: number, count: number) => (count === 0 ? start + 1 : start);
const lastLine = (start: number, count: number) => (count === 0 ? start : start + count - 1);

/**
 * `all` lists all of the file's hunks when `hunks` is only some of them (in
 * order, the same objects): the others become part of the gaps.
 */
export function computeGaps(hunks: Hunk[], oldCount: number | null, newCount: number | null, all?: Hunk[]): Gap[] {
  const gaps: Gap[] = [];
  const pos = hunks.map((h) => all?.indexOf(h) ?? -1);
  // Ignore a list that does not match (e.g. while the file is changing).
  if (pos.includes(-1)) all = undefined;
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
    const gap: Gap = { index: i, oldStart: prevOld + 1, newStart: prevNew + 1, size: size === null ? null : Math.max(0, size) };
    if (all) {
      const inside = all.slice(i === 0 ? 0 : pos[i - 1] + 1, h ? pos[i] : all.length);
      if (inside.length) {
        gap.hunks = inside;
        // Each hunk replaces the old lines it covers.
        if (gap.size !== null) for (const o of inside) gap.size += o.lines.length - o.oldLines;
      }
    }
    gaps.push(gap);
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

function gapParts(gap: Gap): GapPart[] {
  const out: GapPart[] = [];
  let oldNo = gap.oldStart;
  let newNo = gap.newStart;
  let used = 0;
  for (const h of gap.hunks ?? []) {
    const before = firstLine(h.oldStart, h.oldLines) - oldNo;
    out.push({ kind: "context", oldStart: oldNo, newStart: newNo, size: before }, { kind: "hunk", hunk: h, size: h.lines.length });
    used += before + h.lines.length;
    oldNo = lastLine(h.oldStart, h.oldLines) + 1;
    newNo = lastLine(h.newStart, h.newLines) + 1;
  }
  out.push({ kind: "context", oldStart: oldNo, newStart: newNo, size: (gap.size ?? 0) - used });
  return out;
}

/** The part holding line `at` of the gap, with the line it starts at. */
function partAt(parts: GapPart[], at: number): { part: GapPart; start: number } | null {
  let start = 0;
  for (const part of parts) {
    if (at >= start && at < start + part.size) return { part, start };
    start += part.size;
  }
  return null;
}

/** Rows for lines [from, to) of a gap. Expanding stops at hunk edges, so hunks are never cut. */
function pushGapLines(rows: Row[], parts: GapPart[], from: number, to: number, view: ViewMode) {
  let start = 0;
  for (const part of parts) {
    const a = Math.max(from, start);
    const b = Math.min(to, start + part.size);
    if (a < b) {
      if (part.kind === "hunk") pushHunkLines(rows, part.hunk.lines, view);
      else for (let k = a - start; k < b - start; k++) pushContext(rows, part.oldStart + k, part.newStart + k, view);
    }
    start += part.size;
  }
}

/** Hunks among lines [from, to) of a gap. */
function hunksIn(parts: GapPart[], from: number, to: number): Hunk[] {
  const out: Hunk[] = [];
  let start = 0;
  for (const part of parts) {
    if (part.kind === "hunk" && start >= from && start < to) out.push(part.hunk);
    start += part.size;
  }
  return out;
}

export function buildRows(file: FileDiff, view: ViewMode, gaps: Gap[], expansions: Expansions, canExpand: boolean): Row[] {
  const rows: Row[] = [];
  const n = file.hunks.length;
  if (n === 0) return rows;

  for (const gap of gaps) {
    const i = gap.index;
    const header = i < n ? file.hunks[i].header : null;
    if (!canExpand || gap.size === null) {
      if (header) rows.push({ kind: "expander", gap: i, header, remaining: 0, up: false, down: false, reveals: [] });
    } else {
      const size = gap.size;
      const parts = gapParts(gap);
      const exp = expansions[i] ?? { top: 0, bottom: 0 };
      // The first gap only grows upwards from the first hunk; the last one only downwards.
      const total = exp.top + exp.bottom;
      const top = i === 0 ? 0 : i === n ? Math.min(total, size) : Math.min(exp.top, size);
      const bottom = i === 0 ? Math.min(total, size) : i === n ? 0 : Math.min(exp.bottom, size - top);
      const remaining = size - top - bottom;

      pushGapLines(rows, parts, 0, top, view);
      if (remaining > 0 || (i === 0 && size === 0)) {
        const more = remaining > 0;
        const up = more && i < n;
        const down = more && i > 0;
        let reveals: Hunk[];
        // A small gap is expanded all at once (see DiffView).
        if (remaining <= EXPAND_STEP) reveals = hunksIn(parts, top, size - bottom);
        else {
          const next = [down ? partAt(parts, top)?.part : null, up ? partAt(parts, size - bottom - 1)?.part : null];
          reveals = [...new Set(next.flatMap((s) => (s?.kind === "hunk" ? [s.hunk] : [])))];
        }
        rows.push({ kind: "expander", gap: i, header, remaining, up, down, reveals });
      }
      pushGapLines(rows, parts, size - bottom, size, view);
    }
    if (i < n) pushHunkLines(rows, file.hunks[i].lines, view);
  }
  return rows;
}

/**
 * Applies a click on an expander. `all` reveals the whole gap. Otherwise it
 * reveals up to EXPAND_STEP lines, stopping at the edge of a hunk inside the
 * gap, or the whole hunk when it is next.
 */
export function expand(expansions: Expansions, gap: Gap, direction: "up" | "down" | "all"): Expansions {
  const cur = expansions[gap.index] ?? { top: 0, bottom: 0 };
  const size = gap.size ?? 0;
  const parts = gapParts(gap);
  const top = Math.min(cur.top, size);
  const end = size - Math.min(cur.bottom, size - top);
  let next: Expansion;
  if (direction === "all") next = { top: size, bottom: 0 };
  else if (direction === "up") {
    const at = partAt(parts, end - 1);
    const to = !at ? end : at.part.kind === "hunk" ? at.start : Math.max(at.start, end - EXPAND_STEP);
    next = { ...cur, bottom: size - to };
  } else {
    const at = partAt(parts, top);
    const to = !at ? top : at.part.kind === "hunk" ? at.start + at.part.size : Math.min(at.start + at.part.size, top + EXPAND_STEP);
    next = { ...cur, top: to };
  }
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
