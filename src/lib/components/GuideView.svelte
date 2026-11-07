<script lang="ts">
  import { groupSections, groupStats, type Guide } from "../guide/guide";
  import type { ChangeItem } from "../guide/items";
  import { renderMarkdown } from "../guide/markdown";
  import type { FileDiff, ViewMode } from "../types";
  import { LINE_H } from "./DiffView.svelte";
  import FileView from "./FileView.svelte";

  interface Props {
    guide: Guide;
    index: number;
    byKey: Map<string, ChangeItem>;
    /** Files as shown (whitespace changes may be hidden), by id. */
    shownFiles: Map<string, FileDiff>;
    view: ViewMode;
    wrap: boolean;
    onselect: (index: number) => void;
    /** Opens a file in the editor (at a line of the new file). */
    onopen: (file: FileDiff, line?: number) => void;
    /** Shows a file in the Files tab. */
    onshowfile: (file: FileDiff) => void;
  }

  let { guide, index, byKey, shownFiles, view, wrap, onselect, onopen, onshowfile }: Props = $props();

  let outer: HTMLDivElement | undefined = $state();
  let fileViews: (FileView | undefined)[] = $state([]);

  const group = $derived(guide.groups[index]);
  const sections = $derived(group ? groupSections(group, byKey, shownFiles) : []);
  const stats = $derived(group ? groupStats(group, byKey) : null);
  const html = $derived(group ? renderMarkdown(group.explanation) : "");
  const prev = $derived(guide.groups[index - 1]);
  const next = $derived(guide.groups[index + 1]);

  // Start each step at the top.
  $effect(() => {
    void group?.id;
    if (outer) outer.scrollTop = 0;
  });

  const STATUS_LABEL = { added: "Added", deleted: "Deleted", modified: "Modified", renamed: "Renamed", copied: "Copied" };

  function firstLine(f: FileDiff): number {
    for (const h of f.hunks) for (const l of h.lines) if (l.type === "add") return l.newNo!;
    return f.hunks[0]?.newStart ?? 1;
  }

  // ---- keyboard API (called by App) ----
  export function scrollLines(n: number) {
    if (outer) outer.scrollTop += n * LINE_H;
  }
  export function scrollPage(dir: 1 | -1) {
    if (outer) outer.scrollTop += dir * (outer.clientHeight - 3 * LINE_H);
  }
  export function scrollToEdge(edge: "top" | "bottom") {
    if (outer) outer.scrollTop = edge === "top" ? 0 : outer.scrollHeight;
  }
  /** Scrolls to the next/previous block of changes in this step. Returns false when there is none. */
  export function jumpChange(dir: 1 | -1): boolean {
    if (!outer) return false;
    const base = outer.getBoundingClientRect().top - outer.scrollTop;
    const positions: number[] = [];
    for (const fv of fileViews) {
      const el = fv?.element();
      if (!el) continue;
      const top = el.getBoundingClientRect().top - base;
      for (const p of fv!.changePositions()) positions.push(top + p);
    }
    positions.sort((a, b) => a - b);
    const margin = 3 * LINE_H + 40;
    const current = outer.scrollTop + margin + 1;
    const target = dir === 1 ? positions.find((p) => p > current) : positions.findLast((p) => p < current - 2);
    if (target === undefined) return false;
    const max = outer.scrollHeight - outer.clientHeight;
    // At the bottom already: the next change cannot be scrolled to the top.
    if (dir === 1 && outer.scrollTop >= max - 1) return false;
    outer.scrollTop = Math.max(0, target - margin);
    return true;
  }
</script>

<div class="guide-view" bind:this={outer}>
  <div class="inner">
    {#if group && stats}
      <header class="step">
        <div class="eyebrow">
          <span class="num">{index + 1}</span>
          <span>Step {index + 1} of {guide.groups.length}</span>
          <span class="dot">·</span>
          <span>{stats.files} {stats.files === 1 ? "file" : "files"}</span>
          {#if stats.additions}<span class="add">+{stats.additions}</span>{/if}
          {#if stats.deletions}<span class="del">−{stats.deletions}</span>{/if}
        </div>
        <h1>{group.title}</h1>
        <!-- Escaped by renderMarkdown. -->
        <div class="prose">{@html html}</div>
      </header>

      {#each sections as s, i (s.file.id + ":" + group.id)}
        {@const f = s.file}
        <section class="card">
          <div class="card-head">
            <span class="badge {f.status}">{STATUS_LABEL[f.status]}</span>
            <a
              class="path"
              href={"#"}
              title="Open {f.path} in editor"
              onclick={(e) => (e.preventDefault(), onopen(f, s.whole ? undefined : firstLine(f)))}
            >
              {#if f.status === "renamed" || f.status === "copied"}<span class="old-path">{f.oldPath}</span> → {f.newPath}{:else}{f.path}{/if}
            </a>
            <span class="spacer"></span>
            <button class="link" title="Show the whole file in the Files tab" onclick={() => onshowfile(f)}>Show file</button>
          </div>
          <div class="card-body" class:whole={s.whole}>
            <FileView
              bind:this={fileViews[i]}
              file={f}
              {view}
              {wrap}
              outer={outer ?? null}
              expandable={false}
              onopenline={f.newPath ? (no) => onopen(f, no) : undefined}
            />
          </div>
        </section>
      {:else}
        <div class="empty">Only whitespace changed in this step. Turn off “Hide whitespace” to see it.</div>
      {/each}

      <nav class="pager">
        {#if prev}
          <button class="page prev" onclick={() => onselect(index - 1)}>
            <span class="dir">← Previous</span>
            <span class="title">{prev.title}</span>
          </button>
        {:else}
          <span></span>
        {/if}
        {#if next}
          <button class="page next" onclick={() => onselect(index + 1)}>
            <span class="dir">Next →</span>
            <span class="title">{next.title}</span>
          </button>
        {:else}
          <div class="done">End of the guide</div>
        {/if}
      </nav>
    {/if}
  </div>
</div>

<style>
  .guide-view {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    background: var(--bg-subtle);
  }
  .inner {
    padding: 24px 24px 32px;
    max-width: 1800px;
    margin: 0 auto;
  }
  .step {
    max-width: 760px;
    margin-bottom: 20px;
  }
  .eyebrow {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .eyebrow .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 11px;
    font-weight: 600;
  }
  .eyebrow .dot {
    color: var(--fg-subtle);
  }
  .add {
    color: var(--status-added);
  }
  .del {
    color: var(--status-deleted);
  }
  h1 {
    margin: 10px 0 8px;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.3;
  }
  .prose {
    font-size: 13.5px;
    line-height: 1.6;
    user-select: text;
    -webkit-user-select: text;
  }
  .prose :global(p) {
    margin: 0 0 8px;
  }
  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 8px;
    padding-left: 20px;
  }
  .prose :global(li) {
    margin: 2px 0;
  }
  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bg-inset);
  }
  .prose :global(pre) {
    margin: 0 0 8px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--bg-inset);
    overflow-x: auto;
  }
  .prose :global(pre code) {
    padding: 0;
    background: none;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    overflow: hidden;
    margin-bottom: 16px;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-muted);
    background: var(--bg-subtle);
  }
  .card-body.whole :global(.image-diff) {
    height: 360px;
  }
  .badge {
    flex: none;
    font-size: 11px;
    font-weight: 600;
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid currentColor;
  }
  .badge.added {
    color: var(--status-added);
  }
  .badge.deleted {
    color: var(--status-deleted);
  }
  .badge.modified {
    color: var(--status-modified);
  }
  .badge.renamed,
  .badge.copied {
    color: var(--status-renamed);
  }
  .path {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .path:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .old-path {
    color: var(--fg-muted);
    font-weight: 400;
  }
  .spacer {
    flex: 1;
  }
  .link {
    flex: none;
    border: none;
    background: none;
    padding: 2px 4px;
    font-size: 12px;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .link:hover {
    color: var(--accent);
  }
  .empty {
    padding: 24px;
    color: var(--fg-muted);
    text-align: center;
  }

  .pager {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-top: 24px;
  }
  .page {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-width: 48%;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    text-align: left;
    cursor: pointer;
  }
  .page.next {
    margin-left: auto;
    text-align: right;
    align-items: flex-end;
  }
  .page:hover {
    border-color: var(--accent);
  }
  .page .dir {
    font-size: 11.5px;
    color: var(--fg-muted);
  }
  .page .title {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .done {
    margin-left: auto;
    align-self: center;
    font-size: 12px;
    color: var(--fg-muted);
  }
</style>
