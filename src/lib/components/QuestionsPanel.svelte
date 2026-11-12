<script lang="ts">
  import { tick } from "svelte";
  import { diagrams } from "../guide/diagrams";
  import { renderMarkdown } from "../guide/markdown";
  import { questionStore as qs } from "../guide/questions.svelte";
  import { linesLabel, type Thread } from "../guide/questions";
  import { SIGN } from "../guide/items";
  import { resolvedTheme } from "../theme.svelte";

  interface Props {
    /** The step's threads, oldest first. */
    threads: Thread[];
    step: number;
    agentName: string | null;
    /** Scrolls the diff to a thread's lines. */
    onreveal: (thread: Thread) => void;
    onclose: () => void;
  }

  let { threads, step, agentName, onreveal, onclose }: Props = $props();

  let list: HTMLDivElement | undefined = $state();

  /** Lines of the selection shown above a thread; the agent gets them all. */
  const QUOTE_LINES = 6;

  const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

  // Elapsed time while the agent works on any thread.
  let now = $state(Date.now());
  const busy = $derived(threads.some((t) => t.startedAt !== null));
  $effect(() => {
    if (!busy) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  function elapsed(since: number): string {
    const s = Math.max(0, Math.floor((now - since) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // Bring a new thread into view, ready to type in.
  $effect(() => {
    const id = qs.active;
    if (!id || !list) return;
    tick().then(() => {
      const el = list?.querySelector<HTMLElement>(`[data-thread="${id}"]`);
      el?.scrollIntoView({ block: "nearest" });
      const box = el?.querySelector<HTMLTextAreaElement>("textarea");
      if (box && threads.find((t) => t.id === id)?.exchanges.length === 0) box.focus();
    });
  });

  function send(id: string, box: HTMLTextAreaElement) {
    qs.ask(id, box.value);
    box.value = "";
  }

  function onkeydown(e: KeyboardEvent, t: Thread) {
    const box = e.currentTarget as HTMLTextAreaElement;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(t.id, box);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // A question not asked yet is dropped with its empty box.
      if (t.exchanges.length === 0 && !box.value.trim()) qs.remove(t.id);
      else box.blur();
    }
  }
</script>

<aside class="questions">
  <header class="head">
    <span class="title">Questions</span>
    <span class="muted">Step {step + 1}</span>
    <span class="spacer"></span>
    <button class="icon" title="Close" aria-label="Close questions" onclick={onclose}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  </header>

  <div class="list" bind:this={list}>
    {#each threads as t (t.id)}
      {@const shown = t.lines.slice(0, QUOTE_LINES)}
      {@const last = t.exchanges.at(-1)}
      <!-- Focusing a thread highlights its lines; its buttons and text box are reachable by keyboard. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
      <article class="thread" class:active={qs.active === t.id} data-thread={t.id} onclick={() => (qs.active = t.id)} onfocusin={() => (qs.active = t.id)}>
        <div class="thread-head">
          <button class="ref" title="Show these lines in the diff" onclick={() => onreveal(t)}>
            <span class="file">{fileName(t.file.path)}</span>
            <span class="lines">{linesLabel(t.lines)}</span>
          </button>
          <span class="spacer"></span>
          <button class="icon" title="Delete this question" aria-label="Delete this question" onclick={(e) => (e.stopPropagation(), qs.remove(t.id))}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" />
            </svg>
          </button>
        </div>
        <pre class="quote">{#each shown as l}<span class="ql {l.type}"><span class="sign">{SIGN[l.type]}</span>{l.text}</span>{/each}{#if t.lines.length > shown.length}<span class="ql more">… {t.lines.length - shown.length} more {t.lines.length - shown.length === 1 ? "line" : "lines"}</span>{/if}</pre>

        {#each t.exchanges as x, i (i)}
          <div class="msg you">
            <div class="who">You</div>
            <div class="text">{x.question}</div>
          </div>
          {#if x.answer !== null}
            {@const html = renderMarkdown(x.answer)}
            <div class="msg agent">
              <div class="who">{agentName ?? "Agent"}</div>
              <!-- Escaped by renderMarkdown. -->
              <div class="prose" use:diagrams={{ html, theme: resolvedTheme() }}>{@html html}</div>
            </div>
          {/if}
        {/each}

        {#if t.startedAt !== null}
          <div class="status">
            <span class="spinner"></span>
            <span>{agentName ?? "The agent"} is thinking… {elapsed(t.startedAt)}</span>
            <span class="spacer"></span>
            <button class="link" onclick={() => qs.cancel(t.id)}>Cancel</button>
          </div>
        {:else if t.error}
          <div class="status error">
            <span>{t.error}</span>
            {#if last?.answer === null}<button class="link" onclick={() => qs.retry(t.id)}>Retry</button>{/if}
          </div>
        {:else}
          <div class="composer">
            <textarea
              rows="2"
              placeholder={t.exchanges.length ? "Ask a follow-up…" : "Ask about these lines…"}
              value={qs.drafts.get(t.id) ?? ""}
              oninput={(e) => qs.drafts.set(t.id, e.currentTarget.value)}
              onkeydown={(e) => onkeydown(e, t)}
            ></textarea>
            <button
              class="send"
              title="Ask (Enter)"
              onclick={(e) => send(t.id, (e.currentTarget.previousElementSibling as HTMLTextAreaElement))}
            >
              Ask
            </button>
          </div>
        {/if}
      </article>
    {:else}
      <div class="empty">
        Select lines in the diff, then click <strong>Ask</strong> to ask {agentName ?? "the agent"} about them.
      </div>
    {/each}
  </div>
</aside>

<style>
  .questions {
    display: flex;
    flex-direction: column;
    width: 380px;
    flex: none;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--bg);
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--border-muted);
  }
  .title {
    font-weight: 600;
  }
  .muted {
    color: var(--fg-muted);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .icon {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .icon:hover {
    color: var(--fg);
    background: var(--bg-inset);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px;
  }
  .empty {
    padding: 24px 8px;
    color: var(--fg-muted);
    text-align: center;
    line-height: 1.5;
  }

  .thread {
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    overflow: hidden;
  }
  .thread.active {
    border-color: var(--accent);
  }
  .thread-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 10px;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border-muted);
  }
  .ref {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .ref .file {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
  }
  .ref .lines {
    flex: none;
    font-size: 12px;
    color: var(--accent);
  }
  .ref:hover .lines {
    text-decoration: underline;
  }
  .quote {
    margin: 0;
    padding: 4px 0;
    max-height: 140px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 18px;
    color: var(--code-fg);
    border-bottom: 1px solid var(--border-muted);
  }
  .ql {
    display: block;
    padding: 0 10px 0 4px;
    white-space: pre;
  }
  .ql.add {
    background: var(--add-line);
  }
  .ql.del {
    background: var(--del-line);
  }
  .ql.more {
    padding-left: 10px;
    color: var(--fg-muted);
    font-family: var(--font-ui);
  }
  .ql .sign {
    display: inline-block;
    width: 2ch;
    color: var(--fg-muted);
  }

  .msg {
    padding: 8px 10px;
  }
  .msg + .msg {
    border-top: 1px solid var(--border-muted);
  }
  .who {
    margin-bottom: 2px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .msg.you .text {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
    user-select: text;
    -webkit-user-select: text;
  }
  .prose {
    line-height: 1.55;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }
  .prose :global(p) {
    margin: 0 0 6px;
  }
  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 6px;
    padding-left: 18px;
  }
  .prose :global(li) {
    margin: 2px 0;
  }
  .prose :global(:last-child) {
    margin-bottom: 0;
  }
  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--bg-inset);
  }
  .prose :global(pre) {
    margin: 0 0 6px;
    padding: 6px 8px;
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
    margin: 4px 0 8px;
    padding: 8px;
    border: 1px solid var(--border-muted);
    border-radius: 6px;
    overflow-x: auto;
  }
  .prose :global(.diagram svg) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
  /* The panel is narrow: the expanded view shows diagrams at full size. */
  .prose :global(.diagram-expand) {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg-muted);
    cursor: pointer;
  }
  .prose :global(.diagram-expand:hover) {
    color: var(--fg);
    border-color: var(--accent);
  }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-top: 1px solid var(--border-muted);
    font-size: 12px;
    color: var(--fg-muted);
  }
  .status.error {
    color: var(--status-deleted);
    word-break: break-word;
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--border-muted);
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    min-height: 36px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    line-height: 1.4;
    outline: none;
  }
  textarea:focus {
    border-color: var(--accent);
  }
  .send {
    flex: none;
    padding: 5px 12px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
  }
  .link {
    flex: none;
    border: none;
    background: none;
    padding: 0;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
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
