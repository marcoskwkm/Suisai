<script lang="ts">
  import type { Snippet } from "svelte";
  import { buildTree, flatten, type TreeNode } from "../tree";
  import type { FileDiff, FileStatus, SessionInfo } from "../types";

  interface Props {
    session: SessionInfo | null;
    files: FileDiff[];
    selectedId: string | null;
    filter: string;
    onselect: (file: FileDiff) => void;
    mode: "files" | "guide";
    onmode: (mode: "files" | "guide") => void;
    /** Shown instead of the file tree in guide mode. */
    guide: Snippet;
  }

  let { session, files, selectedId, filter = $bindable(), onselect, mode, onmode, guide }: Props = $props();

  let collapsed = $state(new Set<string>());
  let list: HTMLDivElement | undefined = $state();
  let filterInput: HTMLInputElement | undefined = $state();

  const tree = $derived(buildTree(files));
  const rows = $derived(flatten(tree, collapsed));
  const totals = $derived(files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }));

  const LETTER: Record<FileStatus, string> = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };

  function toggle(node: TreeNode) {
    const next = new Set(collapsed);
    if (next.has(node.path)) next.delete(node.path);
    else next.add(node.path);
    collapsed = next;
  }

  // Keep the selected file visible.
  $effect(() => {
    if (!selectedId) return;
    const el = list?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });

  export function focusFilter() {
    filterInput?.focus();
    filterInput?.select();
  }
</script>

<aside class="sidebar">
  <header>
    <div class="title" title={session?.title}>{session?.title ?? ""}</div>
    {#if session?.subtitle}<div class="subtitle" title={session.subtitle}>{session.subtitle}</div>{/if}
  </header>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={mode === "files"} class:active={mode === "files"} onclick={() => onmode("files")}>Files</button>
    <button role="tab" aria-selected={mode === "guide"} class:active={mode === "guide"} onclick={() => onmode("guide")} title="AI review guide (a)">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 1.5c.3 2.9 1.6 4.2 4.5 4.5-2.9.3-4.2 1.6-4.5 4.5-.3-2.9-1.6-4.2-4.5-4.5C6.4 5.7 7.7 4.4 8 1.5Z" />
        <path d="M12.5 9.5c.15 1.4.8 2.05 2 2.25-1.2.2-1.85.85-2 2.25-.15-1.4-.8-2.05-2-2.25 1.2-.2 1.85-.85 2-2.25Z" opacity=".7" />
      </svg>
      Guide
    </button>
  </div>

  {#if mode === "guide"}
    {@render guide()}
  {:else}

  <div class="filter">
    <input
      bind:this={filterInput}
      bind:value={filter}
      placeholder="Filter files…"
      spellcheck="false"
      autocomplete="off"
      onkeydown={(e) => {
        if (e.key === "Escape") {
          filter = "";
          filterInput?.blur();
        }
      }}
    />
  </div>

  <div class="list" bind:this={list} role="tree">
    {#each rows as { node, depth } (node.kind + node.path)}
      {#if node.kind === "dir"}
        <button class="row dir" style:--depth={depth} onclick={() => toggle(node)} title={node.path}>
          <svg class="chevron" class:closed={collapsed.has(node.path)} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="name">{node.name}</span>
        </button>
      {:else}
        {@const f = node.file}
        <button
          class="row file"
          class:selected={f.id === selectedId}
          style:--depth={depth}
          data-id={f.id}
          onclick={() => onselect(f)}
          title={f.status === "renamed" ? `${f.oldPath} → ${f.newPath}` : f.path}
        >
          <span class="status {f.status}">{LETTER[f.status]}</span>
          <span class="name" class:deleted={f.status === "deleted"}>{node.name}</span>
          <span class="counts">
            {#if f.binary}
              <span class="bin">BIN</span>
            {:else}
              {#if f.additions}<span class="add">+{f.additions}</span>{/if}
              {#if f.deletions}<span class="del">−{f.deletions}</span>{/if}
            {/if}
          </span>
        </button>
      {/if}
    {:else}
      <div class="empty">{filter ? "No matching files" : ""}</div>
    {/each}
  </div>

  <footer>
    <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
    <span class="add">+{totals.add}</span>
    <span class="del">−{totals.del}</span>
  </footer>
  {/if}
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-subtle);
    min-width: 0;
  }
  header {
    padding: 12px 12px 8px;
  }
  .title {
    font-weight: 600;
    font-size: 14px;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .subtitle {
    margin-top: 2px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tabs {
    display: flex;
    gap: 2px;
    margin: 0 8px 8px;
    padding: 2px;
    border-radius: 7px;
    background: var(--bg-inset);
  }
  .tabs button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 24px;
    border: none;
    border-radius: 5px;
    background: transparent;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .tabs button:hover {
    color: var(--fg);
  }
  .tabs button.active {
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }
  .filter {
    padding: 0 8px 8px;
  }
  .filter input {
    width: 100%;
    padding: 5px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font-size: 13px;
    outline: none;
  }
  .filter input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0 4px 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    height: 28px;
    padding: 0 8px 0 calc(8px + var(--depth) * 14px);
    border: none;
    border-radius: 4px;
    background: transparent;
    text-align: left;
    font-size: 13.5px;
    line-height: 1;
    cursor: pointer;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.selected {
    background: var(--bg-selected);
  }
  .chevron {
    flex: none;
    color: var(--fg-muted);
    transition: transform 0.12s ease;
  }
  .chevron.closed {
    transform: rotate(-90deg);
  }
  .dir .name {
    color: var(--fg-muted);
    font-weight: 500;
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.deleted {
    text-decoration: line-through;
    color: var(--fg-muted);
  }
  .status {
    flex: none;
    width: 15px;
    font-size: 11.5px;
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
  .counts {
    flex: none;
    display: flex;
    gap: 5px;
    font-size: 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .add {
    color: var(--status-added);
  }
  .del {
    color: var(--status-deleted);
  }
  .bin {
    color: var(--fg-subtle);
  }
  .empty {
    padding: 12px;
    color: var(--fg-muted);
    font-size: 12px;
  }
  footer {
    display: flex;
    gap: 8px;
    padding: 9px 12px;
    border-top: 1px solid var(--border-muted);
    font-size: 12.5px;
    color: var(--fg-muted);
  }
  footer .add,
  footer .del {
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
</style>
