// Estimates how many screen lines a line of code takes when wrapped, so rows
// can be positioned before they are drawn. Rows on screen are then measured
// and corrected, so the estimate only has to be close.

const TAB = 4;

/** East Asian wide and fullwidth characters, and emoji, which take two columns. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Screen lines `text` takes in a box `cols` characters wide, wrapping at
 * spaces like `white-space: pre-wrap; overflow-wrap: anywhere`: words move to
 * the next line when they do not fit, and words longer than a line are split.
 */
export function wrappedLines(text: string, cols: number): number {
  if (cols < 1 || text.length === 0) return 1;
  let lines = 1;
  let col = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      // Spaces at the end of a line hang past the edge instead of wrapping.
      col = c === "\t" ? col + TAB - (col % TAB) : col + 1;
      i++;
      continue;
    }
    // A word: up to the next space.
    let width = 0;
    let j = i;
    while (j < text.length && text[j] !== " " && text[j] !== "\t") {
      const cp = text.codePointAt(j)!;
      width += isWide(cp) ? 2 : 1;
      j += cp > 0xffff ? 2 : 1;
    }
    if (col >= cols || (col > 0 && col + width > cols)) {
      lines++;
      col = 0;
    }
    if (width > cols - col) {
      // Too long for a whole line: it fills lines and ends on the last one.
      const rest = width - (cols - col);
      lines += Math.ceil(rest / cols);
      col = rest % cols || cols;
    } else {
      col += width;
    }
    i = j;
  }
  return lines;
}
