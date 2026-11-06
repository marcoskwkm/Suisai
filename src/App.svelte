<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount, tick } from "svelte";
  import FileView from "./lib/components/FileView.svelte";
  import Shortcuts from "./lib/components/Shortcuts.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import { clearContentCache, prefetch } from "./lib/content";
  import { preloadLanguages } from "./lib/highlight/client";
  import { cycleTheme, theme } from "./lib/theme.svelte";
  import { detectLanguage } from "./lib/highlight/languages";
  import { editorTarget, getDiff, getSession, openInEditor } from "./lib/git/api";
  import { applyIgnoreWhitespace, parsePatch, relativizePaths } from "./lib/git/parse";
  import { buildTree, fileOrder } from "./lib/tree";
  import type { FileDiff, SessionInfo, ViewMode } from "./lib/types";

  // ---- preferences (remembered between runs) ----
  function pref<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  }
  function savePref(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }

  let view = $state<ViewMode>(pref("view", "split"));
  let ignoreWhitespace = $state<boolean>(pref("ignoreWhitespace", false));
  let sidebarWidth = $state<number>(pref("sidebarWidth", 280));
  let sidebarVisible = $state<boolean>(pref("sidebarVisible", true));
  $effect(() => savePref("view", view));
  $effect(() => savePref("ignoreWhitespace", ignoreWhitespace));
  $effect(() => savePref("sidebarWidth", sidebarWidth));
  $effect(() => savePref("sidebarVisible", sidebarVisible));

  // ---- data ----
  let session = $state.raw<SessionInfo | null>(null);
  let files = $state.raw<FileDiff[]>([]);
  let selectedId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let filter = $state("");
  let showHelp = $state(false);

  let fileView: FileView | undefined = $state();
  let sidebar: Sidebar | undefined = $state();

  const visibleFiles = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q) || f.oldPath?.toLowerCase().includes(q)) : files;
  });
  const ordered = $derived(fileOrder(buildTree(visibleFiles)));
  const selected = $derived(files.find((f) => f.id === selectedId) ?? null);
  const selectedIndex = $derived(ordered.findIndex((f) => f.id === selectedId));

  // ---- opening the selected file in an editor ----
  /** Where the selected file is on disk, if it can be opened. */
  let editorPath = $state<{ id: string; path: string } | null>(null);
  $effect(() => {
    const f = selected;
    editorPath = null;
    if (!f?.newPath) return;
    let cancelled = false;
    editorTarget(f.newPath).then(
      (p) => {
        if (!cancelled && p) editorPath = { id: f.id, path: p };
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  });
  const canOpen = $derived(selected !== null && editorPath?.id === selected.id);

  /** The first changed line in the new file, to place the cursor there. */
  function firstChangedLine(f: FileDiff): number {
    for (const h of f.hunks) for (const l of h.lines) if (l.type === "add") return l.newNo!;
    return f.hunks[0]?.newStart ?? 1;
  }

  function openSelected(line?: number) {
    const f = selected;
    if (!f?.newPath || !canOpen) return;
    openInEditor(f.newPath, line ?? firstChangedLine(f)).catch((e) => console.error(e));
  }

  async function load() {
    loading = true;
    try {
      session ??= await getSession();
      if (session.error) {
        error = session.error;
        return;
      }
      const out = await getDiff(ignoreWhitespace);
      const prepare = (patch: string) => {
        const parsed = parsePatch(patch);
        return session!.mode === "paths" ? relativizePaths(parsed, session!.leftRoot!, session!.rightRoot!, session!.fileName) : parsed;
      };
      let next = prepare(out.patch);
      if (out.ignoreWhitespacePatch !== null) next = applyIgnoreWhitespace(next, prepare(out.ignoreWhitespacePatch));
      const previous = selected;
      files = next;
      preloadLanguages(next.map((f) => detectLanguage(f.path)).filter((l): l is string => l !== null));
      error = null;
      // Keep the current file selected across reloads when possible.
      const keep = previous && (next.find((f) => f.id === previous.id) ?? next.find((f) => f.path === previous.path));
      const order = fileOrder(buildTree(next));
      selectedId = keep ? keep.id : (order[0]?.id ?? null);
      startPrefetch(order);
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // Highlight the files after the selected one in the background.
  let prefetching: AbortController | null = null;
  function startPrefetch(order: FileDiff[]) {
    prefetching?.abort();
    prefetching = new AbortController();
    const i = Math.max(0, order.findIndex((f) => f.id === selectedId));
    prefetch([...order.slice(i + 1), ...order.slice(0, i)], prefetching.signal);
  }

  function toggleWhitespace() {
    ignoreWhitespace = !ignoreWhitespace;
    load();
  }

  function reload() {
    clearContentCache();
    load();
  }

  function selectRelative(delta: number) {
    if (ordered.length === 0) return;
    const i = selectedIndex < 0 ? 0 : (selectedIndex + delta + ordered.length) % ordered.length;
    selectedId = ordered[i].id;
  }

  function closeWindow() {
    getCurrentWindow().close();
  }

  function onkeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (showHelp) {
      if (e.key === "Escape" || e.key === "?" || e.key === "q") {
        showHelp = false;
        e.preventDefault();
      }
      return;
    }

    const fv = fileView;
    const actions: Record<string, () => void> = {
      j: () => fv?.scrollLines(3),
      ArrowDown: () => fv?.scrollLines(3),
      k: () => fv?.scrollLines(-3),
      ArrowUp: () => fv?.scrollLines(-3),
      " ": () => fv?.scrollPage(e.shiftKey ? -1 : 1),
      PageDown: () => fv?.scrollPage(1),
      PageUp: () => fv?.scrollPage(-1),
      g: () => fv?.scrollToEdge("top"),
      G: () => fv?.scrollToEdge("bottom"),
      Home: () => fv?.scrollToEdge("top"),
      End: () => fv?.scrollToEdge("bottom"),
      n: () => {
        if (!fv?.jumpChange(1)) selectRelative(1);
      },
      p: () => {
        if (!fv?.jumpChange(-1)) selectRelative(-1);
      },
      Tab: () => selectRelative(e.shiftKey ? -1 : 1),
      "]": () => selectRelative(1),
      "[": () => selectRelative(-1),
      s: () => (view = view === "split" ? "unified" : "split"),
      w: toggleWhitespace,
      b: () => (sidebarVisible = !sidebarVisible),
      t: cycleTheme,
      o: openSelected,
      r: reload,
      "/": () => {
        sidebarVisible = true;
        tick().then(() => sidebar?.focusFilter());
      },
      "?": () => (showHelp = true),
      q: closeWindow,
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  }

  // ---- sidebar resizing ----
  const COLLAPSE_BELOW = 120;
  /** True while dragging, so the width follows the pointer without animating. */
  let resizing = $state(false);
  function startResize(e: PointerEvent) {
    resizing = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = startW + ev.clientX - startX;
      // Dragging far enough to the left collapses the sidebar.
      if (w < COLLAPSE_BELOW) {
        sidebarVisible = false;
        up();
        return;
      }
      sidebarWidth = Math.min(640, Math.max(180, w));
    };
    const up = () => {
      resizing = false;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  const THEME_LABEL = { system: "System", light: "Light", dark: "Dark" };
  const STATUS_LABEL = { added: "Added", deleted: "Deleted", modified: "Modified", renamed: "Renamed", copied: "Copied" };
</script>

<svelte:window {onkeydown} />

<div
  class="app"
  class:resizing
  class:collapsed={!sidebarVisible}
  style:--sidebar-w="{sidebarVisible ? sidebarWidth : 0}px"
  style:--sidebar-full="{sidebarWidth}px"
>
  <!-- Always rendered so collapsing can animate; inert while hidden. -->
  <div class="sidebar-wrap" inert={!sidebarVisible} aria-hidden={!sidebarVisible}>
    <div class="sidebar-inner">
      <Sidebar bind:this={sidebar} {session} files={visibleFiles} {selectedId} bind:filter onselect={(f) => (selectedId = f.id)} />
    </div>
  </div>
  <div class="resizer" role="separator" aria-orientation="vertical" onpointerdown={startResize}></div>

  <main>
    <div class="toolbar">
      <button
        class="icon-button sidebar-toggle"
        class:active={sidebarVisible}
        onclick={() => (sidebarVisible = !sidebarVisible)}
        title={sidebarVisible ? "Hide sidebar (b)" : "Show sidebar (b)"}
        aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
        aria-pressed={sidebarVisible}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" />
          {#if sidebarVisible}<rect x="1.5" y="2.5" width="4.5" height="11" rx="2" fill="currentColor" opacity="0.35" stroke="none" />{/if}
        </svg>
      </button>
      <div class="file-info">
        {#if selected}
          <span class="badge {selected.status}">{STATUS_LABEL[selected.status]}</span>
          {#snippet pathText(f: FileDiff)}
            {#if (f.status === "renamed" || f.status === "copied") && f.oldPath !== f.newPath}
              <span class="old-path">{f.oldPath}</span> → {f.newPath}
            {:else}
              {f.path}
            {/if}
          {/snippet}
          {#if canOpen}
            <a class="path" href={"#"} title="Open {editorPath?.path} in editor (o)" onclick={(e) => (e.preventDefault(), openSelected())}>
              {@render pathText(selected)}
            </a>
          {:else}
            <span class="path" title={selected.path}>{@render pathText(selected)}</span>
          {/if}
          {#if !selected.binary}
            <span class="stat add">+{selected.additions}</span>
            <span class="stat del">−{selected.deletions}</span>
          {/if}
          {#if selected.oldMode && selected.newMode && selected.oldMode !== selected.newMode}
            <span class="mode">{selected.oldMode} → {selected.newMode}</span>
          {/if}
        {/if}
      </div>
      <div class="controls">
        {#if ordered.length > 0}
          <span class="position">{selectedIndex + 1} / {ordered.length}</span>
        {/if}
        <label class="toggle" title="Hide whitespace changes (w)">
          <input type="checkbox" checked={ignoreWhitespace} onchange={toggleWhitespace} />
          Hide whitespace
        </label>
        <div class="segmented" role="group" aria-label="Diff layout">
          <button class:active={view === "split"} onclick={() => (view = "split")} title="Side by side (s)">Split</button>
          <button class:active={view === "unified"} onclick={() => (view = "unified")} title="Unified (s)">Unified</button>
        </div>
        <button
          class="icon-button theme-toggle"
          onclick={cycleTheme}
          title="Theme: {THEME_LABEL[theme.pref]} (t)"
          aria-label="Theme: {THEME_LABEL[theme.pref]}. Click to change."
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            {#if theme.pref === "light"}
              <circle cx="8" cy="8" r="3" />
              <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
            {:else if theme.pref === "dark"}
              <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />
            {:else}
              <circle cx="8" cy="8" r="5.5" />
              <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
            {/if}
          </svg>
        </button>
        <button class="icon-button" onclick={() => (showHelp = true)} title="Keyboard shortcuts (?)">?</button>
      </div>
    </div>

    <div class="content">
      {#if error}
        <div class="state">
          <h2>Nothing to show</h2>
          <p class="error">{error}</p>
          <p>Run <code>ss</code> from inside a git repository, or set it up as git's difftool.</p>
        </div>
      {:else if loading && files.length === 0}
        <div class="state"><p>Loading…</p></div>
      {:else if files.length === 0}
        <div class="state">
          <h2>No changes</h2>
          <p><code>{session?.subtitle}</code> has nothing to show.</p>
        </div>
      {:else if selected}
        <FileView bind:this={fileView} file={selected} {view} onopenline={canOpen ? openSelected : undefined} />
      {/if}
    </div>
  </main>

  {#if showHelp}
    <Shortcuts onclose={() => (showHelp = false)} />
  {/if}
</div>

<style>
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-w) auto minmax(0, 1fr);
    height: 100%;
    transition: grid-template-columns 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .app.resizing {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .app {
      transition: none;
    }
  }
  .sidebar-wrap {
    min-width: 0;
    overflow: hidden;
  }
  /* Keeps its full width while the column shrinks, so the text slides out instead of rewrapping. */
  .sidebar-inner {
    width: var(--sidebar-full);
    height: 100%;
  }
  .collapsed .resizer {
    visibility: hidden;
    pointer-events: none;
  }
  .resizer {
    width: 5px;
    margin: 0 -2px;
    z-index: 2;
    cursor: col-resize;
    position: relative;
  }
  .resizer::after {
    content: "";
    position: absolute;
    inset: 0 2px;
    background: var(--border);
  }
  .resizer:hover::after {
    inset: 0 1px;
    background: var(--accent);
  }
  main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    grid-column: 3;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 40px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex: none;
  }
  .sidebar-toggle,
  .theme-toggle {
    flex: none;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
  }
  .sidebar-toggle svg,
  .theme-toggle svg {
    flex: none;
  }
  .sidebar-toggle:hover,
  .theme-toggle:hover {
    color: var(--fg);
    background: var(--bg-hover);
  }
  .file-info {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .path {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    user-select: text;
    -webkit-user-select: text;
  }
  a.path {
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  a.path:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .old-path {
    color: var(--fg-muted);
    font-weight: 400;
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
  .stat {
    flex: none;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .stat.add {
    color: var(--status-added);
  }
  .stat.del {
    color: var(--status-deleted);
  }
  .mode {
    flex: none;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
  }
  .position {
    font-size: 12px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    cursor: pointer;
  }
  .segmented {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .segmented button {
    border: none;
    background: var(--bg);
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .segmented button + button {
    border-left: 1px solid var(--border);
  }
  .segmented button.active {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .icon-button {
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-size: 12px;
    cursor: pointer;
  }
  .content {
    flex: 1;
    min-height: 0;
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
    color: var(--fg-muted);
    text-align: center;
  }
  .state h2 {
    margin: 0 0 8px;
    color: var(--fg);
    font-size: 18px;
    font-weight: 600;
  }
  .state p {
    margin: 4px 0;
  }
  .state .error {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--status-deleted);
    white-space: pre-wrap;
    user-select: text;
    -webkit-user-select: text;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
  }
</style>
