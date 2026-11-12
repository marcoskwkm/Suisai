<script lang="ts">
  import { tick } from "svelte";
  import { groupSections, groupStats, type Guide } from "../guide/guide";
  import type { ChangeItem } from "../guide/items";
  import { diagrams } from "../guide/diagrams";
  import { renderMarkdown } from "../guide/markdown";
  import { lineKeys, type Thread } from "../guide/questions";
  import { questionStore as qs } from "../guide/questions.svelte";
  import { AGENT_NAMES, guideStore as gs } from "../guide/store.svelte";
  import { resolvedTheme } from "../theme.svelte";
  import type { DiffLine, FileDiff, Hunk, ViewMode } from "../types";
  import { LINE_H } from "./DiffView.svelte";
  import FileView from "./FileView.svelte";
  import QuestionsPanel from "./QuestionsPanel.svelte";

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
    /** Sections marked as viewed (by key): they are collapsed. */
    viewed: ReadonlySet<string>;
    onviewed: (key: string, viewed: boolean) => void;
  }

  let { guide, index, byKey, shownFiles, view, wrap, onselect, onopen, onshowfile, viewed, onviewed }: Props = $props();

  let outer: HTMLDivElement | undefined = $state();
  let inner: HTMLDivElement | undefined = $state();
  let fileViews: (FileView | undefined)[] = $state([]);

  const group = $derived(guide.groups[index]);
  const sections = $derived(group ? groupSections(guide, index, byKey, shownFiles) : []);
  const stats = $derived(group ? groupStats(group, byKey) : null);
  const html = $derived(group ? renderMarkdown(group.explanation) : "");
  const prev = $derived(guide.groups[index - 1]);
  const next = $derived(guide.groups[index + 1]);

  // Start each step at the top.
  $effect(() => {
    void group?.id;
    if (outer) outer.scrollTop = 0;
    pending = null;
  });

  // ---- questions about lines ----

  const agentName = $derived(gs.connected ? AGENT_NAMES[gs.connected] : null);
  const threads = $derived(group ? qs.forStep(group.id) : []);
  /** The lines of the thread in focus are highlighted while the panel is open. */
  const activeThread = $derived(qs.open ? (threads.find((t) => t.id === qs.active) ?? null) : null);
  const activeKeys = $derived(activeThread ? lineKeys(activeThread.lines) : undefined);

  /** Lines just selected in a section, and where to show the Ask button (in `inner`'s coordinates). */
  let pending = $state<{ section: number; lines: DiffLine[]; x: number; y: number } | null>(null);
  /** About the Ask button's width, to keep it inside the view. */
  const ASK_W = 140;

  function onselectlines(section: number, lines: DiffLine[] | null, at: { x: number; y: number }) {
    if (!lines || !inner) {
      pending = null;
      return;
    }
    const r = inner.getBoundingClientRect();
    pending = { section, lines, x: Math.max(0, Math.min(at.x - r.left, r.width - ASK_W)), y: at.y - r.top };
  }

  // The button goes away with the selection.
  $effect(() => {
    const onchange = () => {
      if (pending && window.getSelection()?.isCollapsed) pending = null;
    };
    document.addEventListener("selectionchange", onchange);
    return () => document.removeEventListener("selectionchange", onchange);
  });

  function ask() {
    const p = pending;
    const s = p && sections[p.section];
    if (!p || !s || !group) return;
    qs.start(group.id, s.file, p.lines);
    window.getSelection()?.removeAllRanges();
    pending = null;
  }

  /** Scrolls to a thread's lines (or its file, when they are not shown), expanding the file if it was collapsed. */
  async function reveal(t: Thread) {
    qs.active = t.id;
    const i = sections.findIndex((s) => s.file.id === t.file.id);
    if (i < 0 || !outer) return;
    if (viewed.has(sections[i].key)) {
      onviewed(sections[i].key, false);
      await tick();
    }
    const base = outer.getBoundingClientRect().top - outer.scrollTop;
    const el = fileViews[i]?.element();
    const offset = fileViews[i]?.lineOffset(t.lines[0]) ?? null;
    const card = outer.querySelector(`[data-section="${i}"]`);
    if (el && offset !== null) outer.scrollTop = Math.max(0, el.getBoundingClientRect().top - base + offset - 3 * LINE_H);
    else if (card) outer.scrollTop = Math.max(0, card.getBoundingClientRect().top - base - 16);
  }

  const STATUS_LABEL = { added: "Added", deleted: "Deleted", modified: "Modified", renamed: "Renamed", copied: "Copied" };

  /**
   * Marks a section as viewed or not. A section collapsed from below its
   * header (e.g. from the bottom of a long diff) is scrolled back into view,
   * so the next file follows.
   */
  async function setViewed(key: string, value: boolean, from: Element) {
    const card = from.closest(".card");
    onviewed(key, value);
    if (!value || !card || !outer) return;
    await tick();
    const top = card.getBoundingClientRect().top - outer.getBoundingClientRect().top;
    if (top < 0) outer.scrollTop += top - 16;
  }

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

<div class="guide-layout">
  <div class="guide-view" bind:this={outer}>
    <div class="inner" bind:this={inner}>
      {#if group && stats}
        <header class="step">
          <div class="eyebrow">
            <span class="num">{index + 1}</span>
            <span>Step {index + 1} of {guide.groups.length}</span>
            <span class="dot">·</span>
            <span>{stats.files} {stats.files === 1 ? "file" : "files"}</span>
            {#if stats.additions}<span class="add">+{stats.additions}</span>{/if}
            {#if stats.deletions}<span class="del">−{stats.deletions}</span>{/if}
            <span class="spacer"></span>
            <button
              class="questions-toggle"
              class:on={qs.open}
              title={qs.open ? "Hide questions" : "Select lines in the diff to ask about them"}
              onclick={() => (qs.open = !qs.open)}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
              </svg>
              Questions{#if threads.length}<span class="count">{threads.length}</span>{/if}
            </button>
          </div>
          <h1>{group.title}</h1>
          <!-- Escaped by renderMarkdown. -->
          <div class="prose" use:diagrams={{ html, theme: resolvedTheme() }}>{@html html}</div>
        </header>

        {#each sections as s, i (s.file.id + ":" + group.id)}
          {@const f = s.file}
          <!-- On an expander that is about to reveal changes from other steps. -->
          {#snippet otherSteps(hunks: Hunk[])}
            {@const steps = [...new Set(hunks.map((h) => s.groupOf?.get(h) ?? null))].filter((g) => g !== null)}
            <span class="other-steps">
              {#if steps.length === 0}
                Expanding shows changes not in the guide
              {:else}
                Expanding shows changes from
                {#each steps as g (g)}
                  <button class="step-link" title="Go to step {g + 1}: {guide.groups[g].title}" onclick={() => onselect(g)}>
                    <span class="num">{g + 1}</span>
                    {#if steps.length === 1}<span class="title">{guide.groups[g].title}</span>{/if}
                  </button>
                {/each}
              {/if}
            </span>
          {/snippet}
          {@const done = viewed.has(s.key)}
          <section class="card" class:viewed={done} data-section={i}>
            <div class="card-head">
              <button
                class="chevron"
                title={done ? "Expand" : "Collapse and mark as viewed"}
                aria-expanded={!done}
                onclick={(e) => setViewed(s.key, !done, e.currentTarget)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
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
              <label class="viewed-toggle" title="Mark as viewed and collapse">
                <input type="checkbox" checked={done} onchange={(e) => setViewed(s.key, e.currentTarget.checked, e.currentTarget)} />
                Viewed
              </label>
            </div>
            {#if !done}
              <div class="card-body" class:whole={s.whole}>
                <FileView
                  bind:this={fileViews[i]}
                  file={f}
                  {view}
                  {wrap}
                  outer={outer ?? null}
                  allHunks={s.allHunks}
                  expanderNote={otherSteps}
                  onopenline={f.newPath ? (no) => onopen(f, no) : undefined}
                  onselectlines={(lines, at) => onselectlines(i, lines, at)}
                  marked={activeThread?.file.id === f.id ? activeKeys : undefined}
                />
              </div>
              {#if !s.whole}
                <!-- So a long diff can be marked without scrolling back up. -->
                <div class="card-foot">
                  <span class="foot-path">{f.path}</span>
                  <button class="mark-viewed" onclick={(e) => setViewed(s.key, true, e.currentTarget)}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 8.5l3.5 3.5L13 4.5" />
                    </svg>
                    Mark as viewed
                  </button>
                </div>
              {/if}
            {/if}
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

        {#if pending}
          <!-- Keeps the selection when pressed, so the click still sees it. -->
          <button
            class="ask"
            style:left="{pending.x}px"
            style:top="{pending.y + 12}px"
            title="Ask {agentName ?? 'the agent'} about these lines"
            onpointerdown={(e) => e.preventDefault()}
            onclick={ask}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 1.5c.3 2.9 1.6 4.2 4.5 4.5-2.9.3-4.2 1.6-4.5 4.5-.3-2.9-1.6-4.2-4.5-4.5C6.4 5.7 7.7 4.4 8 1.5Z" />
            </svg>
            Ask about {pending.lines.length === 1 ? "line" : "lines"}
          </button>
        {/if}
      {/if}
    </div>
  </div>
  {#if qs.open && group}
    <QuestionsPanel {threads} step={index} {agentName} onreveal={reveal} onclose={() => (qs.open = false)} />
  {/if}
</div>

<style>
  .guide-layout {
    display: flex;
    height: 100%;
  }
  .guide-view {
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    background: var(--bg-subtle);
  }
  .inner {
    position: relative;
    padding: 24px 24px 32px;
    max-width: 1800px;
    margin: 0 auto;
  }
  .step {
    margin-bottom: 20px;
  }
  /* Text stays in a readable column; diagrams can use the full width. */
  .step h1,
  .prose :global(p),
  .prose :global(ul),
  .prose :global(ol),
  .prose :global(pre) {
    max-width: 760px;
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
  .questions-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-size: 12px;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .questions-toggle:hover,
  .questions-toggle.on {
    color: var(--fg);
    border-color: var(--accent);
  }
  .questions-toggle .count {
    min-width: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 10.5px;
    font-weight: 600;
    text-align: center;
  }
  .ask {
    position: absolute;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    cursor: pointer;
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
  .prose :global(.diagram) {
    position: relative;
    width: fit-content;
    min-width: min(100%, 760px);
    max-width: 100%;
    margin: 4px 0 12px;
    padding: 16px;
    border: 1px solid var(--border-muted);
    border-radius: 8px;
    background: var(--bg);
    overflow-x: auto;
    text-align: center;
  }
  .prose :global(.diagram svg) {
    display: block;
    margin: 0 auto;
  }
  .prose :global(.diagram-expand) {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .prose :global(.diagram:hover .diagram-expand),
  .prose :global(.diagram-expand:focus-visible) {
    opacity: 1;
  }
  .prose :global(.diagram-expand:hover) {
    color: var(--fg);
    border-color: var(--accent);
  }
  /* Until drawn (or if it cannot be), the diagram shows its source. */
  .prose :global(.diagram pre) {
    margin: 0;
    text-align: left;
  }
  .prose :global(.diagram.failed)::after {
    content: "This diagram could not be drawn (hover for details).";
    display: block;
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--fg-muted);
    text-align: left;
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
    padding: 0 12px 0 6px;
    border-bottom: 1px solid var(--border-muted);
    background: var(--bg-subtle);
  }
  .card.viewed .card-head {
    border-bottom: none;
  }
  .card.viewed .path {
    color: var(--fg-muted);
  }
  .chevron {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .chevron:hover {
    color: var(--fg);
    background: var(--bg-inset);
  }
  .card.viewed .chevron svg {
    transform: rotate(-90deg);
  }
  .viewed-toggle {
    flex: none;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .viewed-toggle input {
    margin: 0;
  }
  .card.viewed .viewed-toggle {
    color: var(--fg);
    border-color: var(--accent);
  }
  .other-steps {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .step-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .step-link:hover .title {
    text-decoration: underline;
  }
  .step-link .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 10.5px;
    font-weight: 600;
  }
  .step-link .title {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    height: 36px;
    padding: 0 12px;
    border-top: 1px solid var(--border-muted);
    background: var(--bg-subtle);
  }
  .foot-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--fg-muted);
  }
  .mark-viewed {
    flex: none;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    font-size: 12px;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .mark-viewed:hover {
    color: var(--fg);
    border-color: var(--accent);
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
