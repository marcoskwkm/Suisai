<script lang="ts">
  import { groupFiles } from "../guide/guide";
  import type { FileStatus } from "../types";
  import { renderMarkdown } from "../guide/markdown";
  import { AGENT_NAMES, guideStore as gs } from "../guide/store.svelte";

  interface Props {
    selected: number;
    onselect: (index: number) => void;
    onsettings: () => void;
  }

  let { selected, onselect, onsettings }: Props = $props();

  let list: HTMLDivElement | undefined = $state();

  /** Files listed per step before the rest are summed up as "N more". */
  const MAX_FILES = 8;
  const LETTER: Record<FileStatus, string> = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };

  function splitPath(path: string): { name: string; dir: string } {
    const i = path.lastIndexOf("/");
    return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
  }

  const guide = $derived(gs.guide);
  const agentName = $derived(gs.connected ? AGENT_NAMES[gs.connected] : null);
  /** Changes in the diff that are not in the guide yet. */
  const unplaced = $derived.by(() => {
    const g = guide;
    if (!g) return 0;
    const known = new Set(g.groups.flatMap((x) => x.keys));
    return gs.items.filter((it) => !known.has(it.key)).length;
  });

  // Elapsed time while the agent works.
  let now = $state(Date.now());
  $effect(() => {
    if (!gs.busy) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const elapsed = $derived.by(() => {
    const s = Math.max(0, Math.floor((now - gs.startedAt) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });

  function ago(t: number): string {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  }

  // Long overviews are cut to a few lines, with a toggle to read the rest.
  let overviewEl: HTMLDivElement | undefined = $state();
  let overviewOpen = $state(false);
  let overviewLong = $state(false);
  $effect(() => {
    const el = overviewEl;
    void guide?.overview;
    if (!el) return;
    const measure = () => {
      // Measured while collapsed: does the text go past the cut?
      if (!overviewOpen) overviewLong = el.scrollHeight > el.clientHeight + 1;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  /** Writes the guide again, or asks to connect an agent first. */
  function regenerate() {
    if (gs.connected) gs.generate();
    else onsettings();
  }

  // Keep the selected step visible.
  $effect(() => {
    void selected;
    list?.querySelector<HTMLElement>(".step.selected")?.scrollIntoView({ block: "nearest" });
  });
</script>

{#snippet spark(size = 14)}
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 1.5c.3 2.9 1.6 4.2 4.5 4.5-2.9.3-4.2 1.6-4.5 4.5-.3-2.9-1.6-4.2-4.5-4.5C6.4 5.7 7.7 4.4 8 1.5Z" />
    <path d="M12.5 9.5c.15 1.4.8 2.05 2 2.25-1.2.2-1.85.85-2 2.25-.15-1.4-.8-2.05-2-2.25 1.2-.2 1.85-.85 2-2.25Z" opacity=".7" />
  </svg>
{/snippet}

<div class="panel">
  {#if !guide}
    <div class="intro">
      <div class="icon">{@render spark(20)}</div>
      {#if gs.busy}
        <h3>Writing the review guide…</h3>
        <p>{agentName} is reading the diff and grouping the changes. This usually takes a minute or two.</p>
        <div class="progress"><span class="spinner"></span><span>{elapsed}</span></div>
        <button class="secondary" onclick={() => gs.cancel()}>Cancel</button>
      {:else}
        <h3>Review guide</h3>
        <p>An AI agent groups the changes by purpose and explains each group, in an order that tells the story of the diff.</p>
        {#if gs.discarded}
          <p class="note">The saved guide was written for changes that are no longer in the diff, so it was discarded.</p>
        {/if}
        {#if gs.error}<p class="error">{gs.error}</p>{/if}
        {#if gs.agents === null}
          <p class="muted">Looking for AI agents…</p>
        {:else if agentName}
          <button class="primary" onclick={() => gs.generate()} disabled={gs.items.length === 0}>
            {@render spark()} Generate guide
          </button>
          <button class="link" onclick={onsettings}>Using {agentName} · Change</button>
        {:else}
          <button class="primary" onclick={onsettings}>Connect an AI agent</button>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="summary">
      <div class="summary-head">
        <div class="title">{guide.title || "Review guide"}</div>
        <button
          class="regen"
          onclick={regenerate}
          disabled={gs.busy === "generating"}
          title={agentName ? "Write the guide again from scratch" : "Connect an AI agent to regenerate the guide"}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 2v3.5H10" stroke-linejoin="round" />
          </svg>
          Regenerate
        </button>
      </div>
      <!-- Escaped by renderMarkdown. -->
      {#if guide.overview}
        <div class="overview" class:expanded={overviewOpen} bind:this={overviewEl}>{@html renderMarkdown(guide.overview)}</div>
        {#if overviewLong}
          <button class="link more-toggle" onclick={() => (overviewOpen = !overviewOpen)}>
            {overviewOpen ? "Show less" : "Show more"}
          </button>
        {/if}
      {/if}
    </div>

    <div class="list" bind:this={list}>
      {#each guide.groups as g, i (g.id)}
        {@const files = groupFiles(g, gs.byKey)}
        {@const additions = files.reduce((n, f) => n + f.additions, 0)}
        {@const deletions = files.reduce((n, f) => n + f.deletions, 0)}
        <button class="step" class:selected={i === selected} onclick={() => onselect(i)}>
          <span class="num">{i + 1}</span>
          <span class="body">
            <span class="name">{g.title}</span>
            <span class="meta">
              {files.length}
              {files.length === 1 ? "file" : "files"}
              {#if additions}<span class="add">+{additions}</span>{/if}
              {#if deletions}<span class="del">−{deletions}</span>{/if}
            </span>
            <span class="files">
              {#each files.slice(0, MAX_FILES) as f (f.file.id)}
                {@const p = splitPath(f.file.path)}
                <span
                  class="file"
                  title={f.file.oldPath && f.file.oldPath !== f.file.newPath ? `${f.file.oldPath} → ${f.file.newPath}` : f.file.path}
                >
                  <span class="status {f.file.status}">{LETTER[f.file.status]}</span>
                  <span class="file-name" class:deleted={f.file.status === "deleted"}>{p.name}</span>
                  <!-- The inner span keeps punctuation (e.g. ".github") in place inside the right-to-left box. -->
                  {#if p.dir}<span class="dir"><span dir="ltr">{p.dir}</span></span>{/if}
                  <span class="counts">
                    {#if f.additions}<span class="add">+{f.additions}</span>{/if}
                    {#if f.deletions}<span class="del">−{f.deletions}</span>{/if}
                  </span>
                </span>
              {/each}
              {#if files.length > MAX_FILES}
                <span class="more">{files.length - MAX_FILES} more {files.length - MAX_FILES === 1 ? "file" : "files"}</span>
              {/if}
            </span>
          </span>
        </button>
      {/each}
    </div>

    <footer>
      {#if gs.busy}
        <div class="status">
          <span class="spinner"></span>
          <span class="grow">
            {#if gs.busy === "generating"}
              Rewriting the guide…
            {:else if unplaced > 0}
              Updating for {unplaced} new {unplaced === 1 ? "change" : "changes"}…
            {:else}
              Refreshing explanations…
            {/if}
          </span>
          <span class="muted">{elapsed}</span>
          <button class="link" onclick={() => gs.cancel()}>Cancel</button>
        </div>
      {:else if gs.error}
        <div class="status error-line">
          <span class="grow" title={gs.error}>Update failed: {gs.error}</span>
          <button class="link" onclick={() => gs.retry()}>Retry</button>
        </div>
      {:else if gs.stale || unplaced > 0}
        <div class="status warn">
          <span class="grow">
            {#if unplaced > 0}
              Out of date: {unplaced} {unplaced === 1 ? "change is" : "changes are"} not in the guide.
            {:else}
              Some explanations may mention removed changes.
            {/if}
          </span>
          {#if agentName}
            <button class="link" onclick={() => gs.sync()}>Update</button>
          {:else}
            <button class="link" onclick={onsettings}>Connect</button>
          {/if}
        </div>
      {/if}
      <div class="muted grow" title="Generated {new Date(guide.createdAt).toLocaleString()}">
        By {AGENT_NAMES[guide.agent]} · updated {ago(guide.updatedAt)}
      </div>
      <div class="actions">
        <button class="link" onclick={regenerate} disabled={gs.busy === "generating"} title="Write the guide again from scratch">
          Regenerate
        </button>
        <button class="link" onclick={() => gs.discard()} title="Delete this guide">Discard</button>
        <button class="link" onclick={onsettings} title="AI agent settings">Settings</button>
      </div>
    </footer>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .intro {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 16px 16px;
  }
  .intro .icon {
    color: var(--accent);
  }
  .intro h3 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 600;
  }
  .intro p {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--fg-muted);
  }
  .intro .error {
    color: var(--status-deleted);
    font-family: var(--font-mono);
    font-size: 11.5px;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }
  .muted {
    color: var(--fg-muted);
  }
  .primary,
  .secondary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
  }
  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .secondary {
    border: 1px solid var(--border);
    background: var(--bg);
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
    flex: none;
  }
  .link:disabled {
    color: var(--fg-subtle);
    cursor: default;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }

  .summary {
    padding: 4px 12px 12px;
    border-bottom: 1px solid var(--border-muted);
  }
  .summary-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 4px;
  }
  .summary .title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: 13px;
    line-height: 1.35;
  }
  .regen {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-size: 11.5px;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .regen:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--accent);
  }
  .regen:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .intro .note {
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--bg-inset);
  }
  .overview {
    font-size: 13px;
    line-height: 1.55;
    color: color-mix(in srgb, var(--fg) 85%, var(--bg-subtle));
    /* About six lines; "Show more" reveals the rest. */
    max-height: calc(13px * 1.55 * 6);
    overflow: hidden;
    user-select: text;
    -webkit-user-select: text;
  }
  .overview.expanded {
    max-height: none;
  }
  .overview :global(p) {
    margin: 0 0 6px;
  }
  .overview :global(p:last-child),
  .overview :global(ul:last-child),
  .overview :global(ol:last-child) {
    margin-bottom: 0;
  }
  .overview :global(ul),
  .overview :global(ol) {
    margin: 0 0 6px;
    padding-left: 18px;
  }
  .overview :global(code) {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--bg-inset);
  }
  .more-toggle {
    margin-top: 4px;
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 4px 8px;
  }
  .step {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    width: 100%;
    padding: 7px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .step:hover {
    background: var(--bg-hover);
  }
  .step.selected {
    background: var(--bg-selected);
  }
  .num {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin-top: 1px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg);
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .step.selected .num {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    font-size: 13px;
    line-height: 1.35;
  }
  .meta {
    display: flex;
    gap: 5px;
    font-size: 11.5px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 4px;
    min-width: 0;
  }
  .file {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    line-height: 18px;
  }
  .status {
    flex: none;
    width: 10px;
    font-size: 10.5px;
    font-weight: 700;
    text-align: center;
  }
  .status.added {
    color: var(--status-added);
  }
  .status.deleted {
    color: var(--status-deleted);
  }
  .status.modified {
    color: var(--status-modified);
  }
  .status.renamed,
  .status.copied {
    color: var(--status-renamed);
  }
  .file-name {
    flex: none;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-name.deleted {
    text-decoration: line-through;
    color: var(--fg-muted);
  }
  .dir {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--fg-subtle);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* Ellipsis at the start, so the closest folders stay visible. */
    direction: rtl;
    text-align: left;
  }
  .counts {
    flex: none;
    margin-left: auto;
    display: flex;
    gap: 4px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .more {
    padding-left: 16px;
    font-size: 11.5px;
    color: var(--fg-muted);
  }
  .add {
    color: var(--status-added);
  }
  .del {
    color: var(--status-deleted);
  }

  footer {
    border-top: 1px solid var(--border-muted);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
  }
  .status,
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .grow {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .warn {
    color: var(--status-modified);
  }
  .error-line {
    color: var(--status-deleted);
  }
  .spinner {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
