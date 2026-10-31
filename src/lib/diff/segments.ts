import type { Token } from "../types";
import type { Ranges } from "./intraline";

export interface Segment extends Token {
  /** Part of a word-level change. */
  hl: boolean;
}

/** Splits syntax tokens at the edges of the emphasized ranges. */
export function segments(text: string, tokens: Token[] | null | undefined, ranges: Ranges | null | undefined): Segment[] {
  const toks: Token[] = tokens && tokens.length ? tokens : [{ t: text }];
  if (!ranges || ranges.length === 0) return toks.map((t) => ({ ...t, hl: false }));

  const out: Segment[] = [];
  let pos = 0;
  let r = 0;
  for (const tok of toks) {
    let start = 0;
    const len = tok.t.length;
    while (start < len) {
      while (r < ranges.length && ranges[r][1] <= pos + start) r++;
      const range = ranges[r];
      const abs = pos + start;
      let end: number;
      let hl: boolean;
      if (!range || range[0] >= pos + len) {
        end = len;
        hl = false;
      } else if (range[0] > abs) {
        end = range[0] - pos;
        hl = false;
      } else {
        end = Math.min(len, range[1] - pos);
        hl = true;
      }
      out.push({ ...tok, t: tok.t.slice(start, end), hl });
      start = end;
    }
    pos += len;
  }
  return out;
}
