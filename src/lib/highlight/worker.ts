/// <reference lib="webworker" />
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import type { Token } from "../types";

export interface HighlightRequest {
  id: number;
  code: string;
  lang: string;
}

/** Loads the highlighter and these languages ahead of time. */
export interface PreloadRequest {
  preload: string[];
}

export interface HighlightResponse {
  id: number;
  lines: Token[][] | null;
}

const THEMES = { light: "github-light", dark: "github-dark" } as const;

let highlighter: Promise<Highlighter> | null = null;
const getHighlighter = () => (highlighter ??= createHighlighter({ themes: Object.values(THEMES), langs: [] }));

async function ensureLanguage(h: Highlighter, lang: string) {
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang as BundledLanguage);
}

async function highlight(code: string, lang: string): Promise<Token[][] | null> {
  if (!(lang in bundledLanguages)) return null;
  const h = await getHighlighter();
  await ensureLanguage(h, lang);
  const { tokens } = h.codeToTokens(code, {
    lang: lang as BundledLanguage,
    themes: THEMES,
    defaultColor: false,
    tokenizeMaxLineLength: 2000,
  });
  return tokens.map((line) =>
    line.map((tok) => {
      const style = (tok.htmlStyle ?? {}) as Record<string, string>;
      const out: Token = { t: tok.content };
      if (style["--shiki-light"]) out.l = style["--shiki-light"];
      if (style["--shiki-dark"]) out.d = style["--shiki-dark"];
      if (tok.fontStyle) out.f = tok.fontStyle;
      return out;
    }),
  );
}

self.onmessage = async (e: MessageEvent<HighlightRequest | PreloadRequest>) => {
  if ("preload" in e.data) {
    const h = await getHighlighter();
    for (const lang of e.data.preload) {
      if (lang in bundledLanguages) await ensureLanguage(h, lang).catch(() => {});
    }
    return;
  }
  const { id, code, lang } = e.data;
  let lines: Token[][] | null = null;
  try {
    lines = await highlight(code, lang);
  } catch (err) {
    console.error("highlight failed", lang, err);
  }
  self.postMessage({ id, lines } satisfies HighlightResponse);
};
