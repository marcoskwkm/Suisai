import { readFile } from "./git/api";
import { clearHighlightCache, highlight, MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES } from "./highlight/client";
import { detectLanguage } from "./highlight/languages";
import type { FileContent, FileDiff, Side, Token } from "./types";

export interface SideContent {
  content: FileContent;
  /** Lines of a text file, without line endings. */
  lines: string[] | null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "svg", "avif", "tiff", "tif"]);
const MIME: Record<string, string> = { svg: "image/svg+xml", jpg: "image/jpeg", ico: "image/x-icon", tif: "image/tiff" };

export function imageMime(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!IMAGE_EXTS.has(ext)) return null;
  return MIME[ext] ?? `image/${ext}`;
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) if (lines[i].endsWith("\r")) lines[i] = lines[i].slice(0, -1);
  return lines;
}

const cache = new Map<string, Promise<SideContent | null>>();

function sideInfo(file: FileDiff, side: Side): { path: string | null; blob: string | null } {
  return side === "old" ? { path: file.oldPath, blob: file.oldBlob } : { path: file.newPath, blob: file.newBlob };
}

function cacheKey(file: FileDiff, side: Side): string | null {
  const { path, blob } = sideInfo(file, side);
  return path === null ? null : `${side}\u0000${path}\u0000${blob ?? ""}`;
}

/** Loads one side of a file, or null when the file does not exist on that side. */
export function loadSide(file: FileDiff, side: Side, asImage = false): Promise<SideContent | null> {
  const { path, blob } = sideInfo(file, side);
  const key = cacheKey(file, side);
  if (path === null || key === null) return Promise.resolve(null);
  const k = key + (asImage ? "\u0000img" : "");
  let p = cache.get(k);
  if (!p) {
    p = readFile(side, path, blob, asImage).then((content) => ({
      content,
      lines: content.kind === "text" ? splitLines(content.text) : null,
    }));
    cache.set(k, p);
  }
  return p;
}

/** Highlights one side; resolves to null when the file is too big or the language unknown. */
export function highlightSide(file: FileDiff, side: Side, lines: string[], background = false): Promise<Token[][] | null> {
  const key = cacheKey(file, side);
  const lang = detectLanguage(file.path, lines[0]);
  if (!key || !lang || lines.length > MAX_HIGHLIGHT_LINES) return Promise.resolve(null);
  const code = lines.join("\n");
  if (code.length > MAX_HIGHLIGHT_CHARS) return Promise.resolve(null);
  return highlight(key, code, lang, background);
}

export function isTooLargeToHighlight(lines: string[] | null): boolean {
  if (!lines) return false;
  if (lines.length > MAX_HIGHLIGHT_LINES) return true;
  let n = 0;
  for (const l of lines) if ((n += l.length + 1) > MAX_HIGHLIGHT_CHARS) return true;
  return false;
}

export function clearContentCache() {
  cache.clear();
  clearHighlightCache();
}

/**
 * Loads and highlights files in the background, one at a time, so they show
 * up colored immediately when opened. Stops when `signal` is aborted.
 */
export async function prefetch(files: FileDiff[], signal: AbortSignal, limit = 100) {
  for (const f of files.slice(0, limit)) {
    if (signal.aborted) return;
    if (f.binary || f.hunks.length === 0) continue;
    const sides = await Promise.all([loadSide(f, "old"), loadSide(f, "new")]);
    for (const [i, side] of (["old", "new"] as const).entries()) {
      const lines = sides[i]?.lines;
      if (lines && !signal.aborted) await highlightSide(f, side, lines, true);
    }
  }
}
