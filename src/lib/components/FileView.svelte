<script lang="ts">
  import { highlightSide, imageMime, isTooLargeToHighlight, loadSide, type SideContent } from "../content";
  import { buildRows, computeGaps, computeIntraline, expand, type Expansions } from "../diff/rows";
  import type { FileDiff, Side, Token, ViewMode } from "../types";
  import DiffView from "./DiffView.svelte";
  import ImageDiff from "./ImageDiff.svelte";

  interface Props {
    file: FileDiff;
    view: ViewMode;
    /** Opens the new file in an editor at a line, when it is on disk. */
    onopenline?: (no: number) => void;
  }

  let { file, view, onopenline }: Props = $props();

  let diffView: DiffView | undefined = $state();
  /**
   * What is on screen. It switches to a new file only once its contents and
   * syntax colors are ready (or after a short timeout), so the code does not
   * flash uncolored while loading.
   */
  interface Shown {
    file: FileDiff;
    id: string;
    old: SideContent | null;
    new: SideContent | null;
    oldTokens: Token[][] | null;
    newTokens: Token[][] | null;
  }
  let shown = $state.raw<Shown | null>(null);
  /** Expanded gaps, for the file object they were made on. */
  let expanded = $state.raw<{ file: FileDiff | null; map: Expansions }>({ file: null, map: {} });

  /** How long to wait for syntax colors before showing plain text. */
  const HIGHLIGHT_WAIT_MS = 250;
  const FIRST_HIGHLIGHT_WAIT_MS = 1000;

  const isImage = $derived(file.binary && imageMime(file.path) !== null);
  const needsText = $derived(!file.binary && file.hunks.length > 0);

  $effect(() => {
    const f = file;
    if (!needsText) return;
    const id = f.id + f.oldBlob + f.newBlob;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    Promise.all([loadSide(f, "old"), loadSide(f, "new")]).then(([o, n]) => {
      if (cancelled) return;
      const old = validate(f, "old", o);
      const nw = validate(f, "new", n);
      const show = (oldTokens: Token[][] | null, newTokens: Token[][] | null) => {
        if (!cancelled) shown = { file: f, id, old, new: nw, oldTokens, newTokens };
      };
      // With nothing on screen yet (first file), waiting longer costs nothing.
      timer = setTimeout(() => show(null, null), shown ? HIGHLIGHT_WAIT_MS : FIRST_HIGHLIGHT_WAIT_MS);
      Promise.all([
        old?.lines ? highlightSide(f, "old", old.lines) : null,
        nw?.lines ? highlightSide(f, "new", nw.lines) : null,
      ]).then(([ot, nt]) => {
        clearTimeout(timer);
        show(ot, nt);
      });
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  /**
   * Drops contents that do not match the diff (e.g. the file changed on disk
   * after git ran). The diff is then shown from git's output alone.
   */
  function validate(f: FileDiff, side: Side, c: SideContent | null): SideContent | null {
    if (!c?.lines) return c;
    const lines = c.lines;
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (side === "old" && l.type === "del" && lines[l.oldNo! - 1] !== l.text) return { ...c, lines: null };
        if (side === "new" && l.type === "add" && lines[l.newNo! - 1] !== l.text) return { ...c, lines: null };
      }
    }
    return c;
  }

  /** The file whose diff is on screen (may lag behind `file` while loading). */
  const df = $derived(shown?.file ?? file);
  const content = $derived(shown);
  const expansions = $derived(expanded.file === df ? expanded.map : {});

  // Text from git's output, used when the full file is not available.
  const fallback = $derived.by(() => {
    const m = new Map<string, string>();
    for (const h of df.hunks)
      for (const l of h.lines) {
        if (l.oldNo !== null) m.set(`old:${l.oldNo}`, l.text);
        if (l.newNo !== null) m.set(`new:${l.newNo}`, l.text);
      }
    return m;
  });

  const oldLines = $derived(content?.old?.lines ?? null);
  const newLines = $derived(content?.new?.lines ?? null);

  const text = $derived.by(() => {
    const ol = oldLines;
    const nl = newLines;
    const fb = fallback;
    return (side: Side, no: number): string => {
      const lines = side === "old" ? ol : nl;
      if (lines && no <= lines.length) return lines[no - 1];
      return fb.get(`${side}:${no}`) ?? "";
    };
  });

  const tokenAt = $derived.by(() => {
    const s = shown;
    return (side: Side, no: number): Token[] | null => (side === "old" ? s?.oldTokens : s?.newTokens)?.[no - 1] ?? null;
  });

  // Expanding needs the full contents of each side that exists.
  const canExpand = $derived(
    content !== null && (df.oldPath === null || oldLines !== null) && (df.newPath === null || newLines !== null),
  );
  const gaps = $derived(
    computeGaps(df.hunks, df.oldPath === null ? 0 : (oldLines?.length ?? null), df.newPath === null ? 0 : (newLines?.length ?? null)),
  );
  const rows = $derived(buildRows(df, view, gaps, expansions, canExpand));
  const intraline = $derived(computeIntraline(df, text));

  function longest(lines: string[] | null, side: Side): number {
    let max = 0;
    const measure = (s: string) => {
      let n = s.length;
      for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 9) n += 3;
      if (n > max) max = n;
    };
    if (lines) lines.forEach(measure);
    else for (const [k, v] of fallback) if (k.startsWith(side)) measure(v);
    return max;
  }
  const maxChars = $derived({ old: longest(oldLines, "old"), new: longest(newLines, "new") });
  const numberDigits = $derived.by(() => {
    let max = Math.max(oldLines?.length ?? 0, newLines?.length ?? 0);
    for (const h of df.hunks) max = Math.max(max, h.oldStart + h.oldLines, h.newStart + h.newLines);
    return Math.max(3, String(max).length);
  });

  const highlightSkipped = $derived(content !== null && (isTooLargeToHighlight(oldLines) || isTooLargeToHighlight(newLines)));
  const notice = $derived.by(() => {
    if (!content) return null;
    const kinds = [content.old?.content.kind, content.new?.content.kind];
    if (kinds.includes("tooLarge")) return "This file is too large to load in full: showing the diff only.";
    if (highlightSkipped) return "Syntax highlighting is off for this file because it is very large.";
    return null;
  });

  function onexpand(gap: number, direction: "up" | "down" | "all") {
    expanded = { file: df, map: expand(expansions, gaps[gap], direction) };
  }

  function formatMode(m: string | null) {
    return m === "100755" ? "executable" : m === "120000" ? "symlink" : m === "160000" ? "submodule" : m;
  }

  const emptyMessage = $derived.by(() => {
    if (file.whitespaceOnly) return "Only whitespace changed in this file. Turn off “Hide whitespace” to see it.";
    if (file.binary) return "Binary file not shown.";
    if (file.status === "renamed") return "File renamed without changes.";
    if (file.status === "copied") return "File copied without changes.";
    if (file.oldMode && file.newMode && file.oldMode !== file.newMode)
      return `File mode changed from ${formatMode(file.oldMode)} to ${formatMode(file.newMode)}.`;
    if (file.status === "added") return "Empty file added.";
    if (file.status === "deleted") return "Empty file deleted.";
    return "No changes to show.";
  });

  export const scrollLines = (n: number) => diffView?.scrollLines(n);
  export const scrollPage = (d: 1 | -1) => diffView?.scrollPage(d);
  export const scrollToEdge = (e: "top" | "bottom") => diffView?.scrollToEdge(e);
  export const jumpChange = (d: 1 | -1) => diffView?.jumpChange(d) ?? false;
</script>

<div class="file-view">
  {#if notice}
    <div class="notice">{notice}</div>
  {/if}
  <div class="body">
    {#if isImage}
      <ImageDiff {file} />
    {:else if !needsText}
      <div class="message">{emptyMessage}</div>
    {:else if shown}
      <DiffView
        bind:this={diffView}
        {rows}
        {view}
        resetKey={shown.id}
        {text}
        tokens={tokenAt}
        {intraline}
        {maxChars}
        {numberDigits}
        {onexpand}
        {onopenline}
      />
    {/if}
  </div>
</div>

<style>
  .file-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .notice {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--fg-muted);
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border-muted);
  }
  .message {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--fg-muted);
    font-size: 14px;
    padding: 24px;
    text-align: center;
  }
</style>
