<script lang="ts" module>
  export const LINE_H = 20;
  export const EXPANDER_H = 32;
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { Ranges } from "../diff/intraline";
  import { changeStarts, type Cell, type LineKey, type Row } from "../diff/rows";
  import { segments, type Segment } from "../diff/segments";
  import { wrappedLines } from "../diff/wrap";
  import type { LineType, Side, Token, ViewMode } from "../types";

  interface Props {
    rows: Row[];
    view: ViewMode;
    /** Changes when a different file is shown: resets scroll positions. */
    resetKey: string;
    text: (side: Side, no: number) => string;
    tokens: (side: Side, no: number) => Token[] | null;
    intraline: Map<LineKey, Ranges>;
    /** Longest line (in characters) on each side, for horizontal scrolling. */
    maxChars: { old: number; new: number };
    numberDigits: number;
    onexpand: (gap: number, direction: "up" | "down" | "all") => void;
    /** Opens the new file in an editor at a line. Without it, line numbers are not links. */
    onopenline?: (no: number) => void;
    /**
     * Inline mode: the diff takes its full height and this element scrolls it
     * (with other content around it). Only the rows in its viewport are drawn.
     */
    outer?: HTMLElement | null;
    /** Wrap long lines instead of scrolling horizontally. */
    wrap?: boolean;
  }

  let {
    rows,
    view,
    resetKey,
    text,
    tokens,
    intraline,
    maxChars,
    numberDigits,
    onexpand,
    onopenline,
    outer = null,
    wrap = false,
  }: Props = $props();

  let scroller: HTMLDivElement;
  let sizer: HTMLDivElement;
  let scrollTop = $state(0);
  let height = $state(0);
  /** Horizontal offsets: split uses old/new, unified uses new for its single pane. */
  let scrollLeft = $state({ old: 0, new: 0 });
  let hbars: Record<Side, HTMLDivElement | undefined> = $state({ old: undefined, new: undefined });
  let selectSide = $state<Side | null>(null);

  // ---- row heights ----
  // Without wrapping, every line is LINE_H tall. With wrapping, heights are
  // estimated from the text and the width of a code column, then corrected
  // by measuring the rows that are drawn.

  /** Width of a code column, and of one character, in pixels (wrap mode). */
  let clipWidth = $state(0);
  let charWidth = $state(0);
  let charProbe: HTMLSpanElement | undefined = $state();
  $effect(() => {
    void numberDigits;
    if (charProbe) charWidth = charProbe.getBoundingClientRect().width / charProbe.textContent!.length;
  });
  const cols = $derived(wrap && charWidth > 0 ? Math.floor(clipWidth / charWidth) : 0);

  const estimates = $derived.by(() => {
    const h = new Float64Array(rows.length);
    const lines = (side: Side, no: number) => wrappedLines(text(side, no), cols);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === "expander") h[i] = EXPANDER_H;
      else if (!cols) h[i] = LINE_H;
      else if (r.kind === "pair")
        h[i] = LINE_H * Math.max(r.left ? lines("old", r.left.no) : 1, r.right ? lines("new", r.right.no) : 1);
      else h[i] = LINE_H * lines(r.type === "del" ? "old" : "new", (r.type === "del" ? r.oldNo : r.newNo)!);
    }
    return h;
  });

  /** Measured heights by row index, valid for one set of rows at one width. */
  let measured = $state.raw<{ rows: Row[]; cols: number; map: Map<number, number> } | null>(null);
  const measuredMap = $derived(cols && measured?.rows === rows && measured.cols === cols ? measured.map : null);

  const offsets = $derived.by(() => {
    const o = new Float64Array(rows.length + 1);
    const m = measuredMap;
    for (let i = 0; i < rows.length; i++) o[i + 1] = o[i] + (m?.get(i) ?? estimates[i]);
    return o;
  });

  // Correct estimates with the heights of the rows on screen, keeping the
  // content under the top edge still.
  $effect(() => {
    void visible;
    void offsets;
    if (!cols) return;
    const changes: [number, number][] = [];
    for (const el of sizer.querySelectorAll<HTMLElement>(":scope > .row[data-i]")) {
      const i = Number(el.dataset.i);
      const h = el.offsetHeight;
      if (i < rows.length && Math.abs(h - (offsets[i + 1] - offsets[i])) > 0.5) changes.push([i, h]);
    }
    if (changes.length === 0) return;
    const top = rowAt(outer ? inlineTop : scroller.scrollTop);
    let shift = 0;
    const map = new Map(measuredMap ?? []);
    for (const [i, h] of changes) {
      if (i < top) shift += h - (offsets[i + 1] - offsets[i]);
      map.set(i, h);
    }
    measured = { rows, cols, map };
    if (shift) (outer ?? scroller).scrollTop += shift;
  });
  const total = $derived(offsets[rows.length]);
  const starts = $derived(changeStarts(rows));

  /** Index of the row containing pixel offset y. */
  function rowAt(y: number): number {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  // In inline mode, the part of the diff inside the outer element's viewport.
  let inlineTop = $state(0);
  let inlineHeight = $state(0);
  $effect(() => {
    const o = outer;
    if (!o) return;
    const update = () => {
      const vp = o.getBoundingClientRect();
      const me = scroller.getBoundingClientRect();
      inlineTop = Math.max(0, vp.top - me.top);
      inlineHeight = Math.max(0, Math.min(vp.bottom, me.bottom) - Math.max(vp.top, me.top));
    };
    update();
    o.addEventListener("scroll", update, { passive: true });
    // Content above this diff can grow (e.g. other files finish loading).
    const ro = new ResizeObserver(update);
    ro.observe(o);
    if (o.firstElementChild) ro.observe(o.firstElementChild);
    ro.observe(scroller);
    return () => {
      o.removeEventListener("scroll", update);
      ro.disconnect();
    };
  });

  const OVERSCAN = 10;
  const range = $derived.by(() => {
    if (rows.length === 0) return { start: 0, end: 0 };
    const top = outer ? inlineTop : scrollTop;
    const h = outer ? inlineHeight : height;
    const start = Math.max(0, rowAt(top) - OVERSCAN);
    const end = Math.min(rows.length, rowAt(top + h) + OVERSCAN + 1);
    return { start, end };
  });
  const visible = $derived(rows.slice(range.start, range.end));

  // Segments are cached per line until the inputs change.
  const segCache = $derived.by(() => {
    void tokens;
    void intraline;
    void text;
    return new Map<string, Segment[]>();
  });

  function segs(side: Side, no: number): Segment[] {
    const key = `${side}:${no}`;
    let s = segCache.get(key);
    if (!s) {
      const t = text(side, no);
      let toks = tokens(side, no);
      if (toks && toks.reduce((n, tk) => n + tk.t.length, 0) !== t.length) toks = null;
      s = segments(t, toks, intraline.get(key as LineKey));
      segCache.set(key, s);
    }
    return s;
  }

  // Remember which line is at the top so switching split/unified keeps the position.
  function lineAt(i: number): { old: number | null; new: number | null } | null {
    for (let k = i; k < Math.min(rows.length, i + 50); k++) {
      const r = rows[k];
      if (r.kind === "line") return { old: r.oldNo, new: r.newNo };
      if (r.kind === "pair") return { old: r.left?.no ?? null, new: r.right?.no ?? null };
    }
    return null;
  }

  let anchor: { old: number | null; new: number | null } | null = null;
  let lastKey = "";
  let lastView: ViewMode | null = null;

  $effect(() => {
    void rows;
    if (resetKey !== lastKey) {
      lastKey = resetKey;
      lastView = view;
      scroller.scrollTop = 0;
      scrollTop = 0;
      scrollLeft = { old: 0, new: 0 };
      if (hbars.old) hbars.old.scrollLeft = 0;
      if (hbars.new) hbars.new.scrollLeft = 0;
      return;
    }
    if (view !== lastView) {
      lastView = view;
      const a = anchor;
      if (!a) return;
      const idx = rows.findIndex((r) =>
        r.kind === "line"
          ? (a.new !== null && r.newNo === a.new) || (a.new === null && r.oldNo === a.old)
          : r.kind === "pair"
            ? (a.new !== null && r.right?.no === a.new) || (a.new === null && r.left?.no === a.old)
            : false,
      );
      if (idx >= 0) {
        scroller.scrollTop = offsets[idx];
        scrollTop = scroller.scrollTop;
      }
    }
  });

  function onscroll() {
    scrollTop = scroller.scrollTop;
    anchor = lineAt(rowAt(scrollTop));
  }

  // Horizontal wheel/trackpad scrolling moves only the pane under the pointer.
  $effect(() => {
    const el = scroller;
    const onwheel = (e: WheelEvent) => {
      if (wrap || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      const side = paneSide(e);
      const bar = hbars[side];
      if (!bar) return;
      e.preventDefault();
      bar.scrollLeft += e.deltaX;
    };
    el.addEventListener("wheel", onwheel, { passive: false });
    return () => el.removeEventListener("wheel", onwheel);
  });

  function paneSide(e: MouseEvent): Side {
    if (view === "unified") return "new";
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-side]");
    if (target) return target.dataset.side as Side;
    const rect = scroller.getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2 ? "old" : "new";
  }

  function onpointerdown(e: PointerEvent) {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-side]");
    selectSide = view === "split" && target ? (target.dataset.side as Side) : null;
    startSelectionScroll(e);
  }

  // ---- auto-scroll while selecting ----
  // Each pane scrolls horizontally by moving its text (not a native scroll
  // container), so the browser cannot auto-scroll it during a selection.
  // While the button is held near or past a pane's edge, scroll it ourselves
  // and keep extending the selection to the point under the pointer.

  /** Distance from a pane's edge where scrolling starts, in pixels. */
  const EDGE = 40;
  const MAX_SPEED = 40;

  let drag: { side: Side; left: number; right: number; x: number; y: number; frame: number } | null = null;

  function startSelectionScroll(e: PointerEvent) {
    if (e.button !== 0) return;
    const code = (e.target as HTMLElement).closest<HTMLElement>(".code");
    const clip = code?.querySelector<HTMLElement>(".clip");
    if (!code || !clip) return;
    const rect = clip.getBoundingClientRect();
    const side = view === "unified" ? "new" : (code.dataset.side as Side);
    drag = { side, left: rect.left, right: rect.right, x: e.clientX, y: e.clientY, frame: requestAnimationFrame(stepSelectionScroll) };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", stopSelectionScroll);
    window.addEventListener("pointercancel", stopSelectionScroll);
  }

  function onDragMove(e: PointerEvent) {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
  }

  function stopSelectionScroll() {
    if (drag) cancelAnimationFrame(drag.frame);
    drag = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", stopSelectionScroll);
    window.removeEventListener("pointercancel", stopSelectionScroll);
  }

  async function stepSelectionScroll() {
    const d = drag;
    if (!d) return;
    const bar = hbars[d.side];
    let speed = 0;
    if (d.x > d.right - EDGE) speed = Math.min(MAX_SPEED, (d.x - (d.right - EDGE)) / 3);
    else if (d.x < d.left + EDGE) speed = -Math.min(MAX_SPEED, (d.left + EDGE - d.x) / 3);

    if (bar && speed !== 0) {
      const before = bar.scrollLeft;
      bar.scrollLeft += speed;
      if (bar.scrollLeft !== before) {
        scrollLeft[d.side] = bar.scrollLeft;
        await tick();
        extendSelection(d);
      }
    }
    if (drag === d) d.frame = requestAnimationFrame(stepSelectionScroll);
  }

  /** Moves the selection's end to the text under the pointer (kept inside the pane). */
  function extendSelection(d: NonNullable<typeof drag>) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const box = scroller.getBoundingClientRect();
    const x = Math.min(Math.max(d.x, d.left + 1), d.right - 1);
    const y = Math.min(Math.max(d.y, box.top + 1), box.bottom - 1);
    const range = document.caretRangeFromPoint?.(x, y);
    if (!range) return;
    const el = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const code = el?.closest<HTMLElement>(".code");
    if (!code || (view === "split" && code.dataset.side !== d.side)) return;
    sel.extend(range.startContainer, range.startOffset);
  }

  $effect(() => stopSelectionScroll);

  // ---- keyboard API (called by App) ----
  export function scrollLines(n: number) {
    scroller.scrollTop += n * LINE_H;
  }
  export function scrollPage(dir: 1 | -1) {
    scroller.scrollTop += dir * (height - 3 * LINE_H);
  }
  export function scrollToEdge(edge: "top" | "bottom") {
    scroller.scrollTop = edge === "top" ? 0 : total;
  }
  /** Inline mode: where each block of changes starts, in pixels from the top of the diff. */
  export function changePositions(): number[] {
    return starts.map((i) => offsets[i]);
  }
  export const element = () => scroller;

  /** Scrolls to the next/previous block of changes. Returns false when there is none. */
  export function jumpChange(dir: 1 | -1): boolean {
    const margin = 3 * LINE_H;
    const current = rowAt(scroller.scrollTop + margin + 1);
    const target = dir === 1 ? starts.find((i) => i > current) : starts.findLast((i) => i < current);
    if (target === undefined) return false;
    scroller.scrollTop = Math.max(0, offsets[target] - margin);
    return true;
  }

  const sign = (t: LineType) => (t === "add" ? "+" : t === "del" ? "-" : " ");
  const hunkLabel = (header: string | null) => header ?? "";
</script>

{#snippet code(side: Side, cell: Cell | null)}
  {#if cell}
    <div class="code {cell.type}" data-side={side}>
      <span class="sign">{sign(cell.type)}</span>
      <div class="clip">
        <div class="text" style:transform={wrap ? undefined : `translateX(${-(view === "unified" ? scrollLeft.new : scrollLeft[side])}px)`}>
          {#each segs(side, cell.no) as s}<span
              class="tok"
              class:hl={s.hl}
              class:it={s.f && s.f & 1}
              class:bd={s.f && s.f & 2}
              style={s.l ? `--l:${s.l};--d:${s.d ?? s.l}` : undefined}>{s.t}</span
            >{/each}
        </div>
      </div>
    </div>
  {:else}
    <div class="code empty" data-side={side}></div>
  {/if}
{/snippet}

{#snippet num(cell: Cell | null, cls = "", side: Side = "old")}
  {#if cell && side === "new" && onopenline}
    {@const no = cell.no}
    <a class="num {cell.type} {cls}" href={"#"} title="Open line {no} in editor" onclick={(e) => (e.preventDefault(), onopenline(no))}
      >{no}</a
    >
  {:else}
    <div class="num {cell?.type ?? 'empty'} {cls}">{cell?.no ?? ""}</div>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="diff"
  class:split={view === "split"}
  class:unified={view === "unified"}
  class:inline={outer !== null}
  class:wrap
  style:--digits={numberDigits}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="scroller"
    class:sel-old={selectSide === "old"}
    class:sel-new={selectSide === "new"}
    bind:this={scroller}
    bind:clientHeight={height}
    {onscroll}
    {onpointerdown}
    tabindex="-1"
  >
    <div class="sizer" style:height="{total}px" bind:this={sizer}>
      {#if wrap}
        <!-- Measures the width of a code column and of a character. -->
        <div class="row line probe" aria-hidden="true">
          <div class="num"></div>
          {#if view === "unified"}<div class="num"></div>{/if}
          <div class="code">
            <span class="sign"></span>
            <div class="clip" bind:clientWidth={clipWidth}><span class="char-probe" bind:this={charProbe}>{"0".repeat(50)}</span></div>
          </div>
          {#if view === "split"}<div class="num"></div><div class="code"></div>{/if}
        </div>
      {/if}
      {#each visible as row, i (range.start + i)}
        {@const top = offsets[range.start + i]}
        {#if row.kind === "expander"}
          <div class="row expander" data-i={range.start + i} style:transform="translateY({top}px)" style:height="{EXPANDER_H}px">
            <div class="expand-buttons">
              {#if row.remaining > 0 && row.remaining <= 20}
                <button title="Expand all" onclick={() => onexpand(row.gap, "all")}>⇕</button>
              {:else}
                {#if row.down}<button title="Expand down" onclick={() => onexpand(row.gap, "down")}>↓</button>{/if}
                {#if row.up}<button title="Expand up" onclick={() => onexpand(row.gap, "up")}>↑</button>{/if}
              {/if}
            </div>
            <div class="hunk-header">{hunkLabel(row.header)}</div>
          </div>
        {:else if row.kind === "pair"}
          <div class="row line" data-i={range.start + i} style:transform="translateY({top}px)">
            {@render num(row.left)}
            {@render code("old", row.left)}
            {@render num(row.right, "right", "new")}
            {@render code("new", row.right)}
          </div>
        {:else}
          {@const cell = { type: row.type, no: (row.type === "del" ? row.oldNo : row.newNo)! }}
          {@const side = row.type === "del" ? "old" : "new"}
          <div class="row line" data-i={range.start + i} style:transform="translateY({top}px)">
            {@render num(row.oldNo === null ? null : { type: row.type, no: row.oldNo })}
            {@render num(row.newNo === null ? null : { type: row.type, no: row.newNo }, "", "new")}
            {@render code(side, cell)}
          </div>
        {/if}
      {/each}
    </div>
  </div>

  {#if !wrap}
  <div class="hscroll">
    {#if view === "split"}
      <div class="num-spacer"></div>
      <div
        class="hbar"
        bind:this={hbars.old}
        onscroll={(e) => (scrollLeft.old = (e.currentTarget as HTMLElement).scrollLeft)}
      >
        <div class="hbar-inner" style:width="calc({maxChars.old + 3}ch + 16px)"></div>
      </div>
      <div class="num-spacer"></div>
    {:else}
      <div class="num-spacer"></div>
      <div class="num-spacer"></div>
    {/if}
    <div
      class="hbar"
      bind:this={hbars.new}
      onscroll={(e) => (scrollLeft.new = (e.currentTarget as HTMLElement).scrollLeft)}
    >
      <div
        class="hbar-inner"
        style:width="calc({(view === 'split' ? maxChars.new : Math.max(maxChars.old, maxChars.new)) + 3}ch + 16px)"
      ></div>
    </div>
  </div>
  {/if}
</div>

<style>
  .diff {
    --num-w: calc(var(--digits) * 1ch + 22px);
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: var(--font-mono);
    font-size: var(--code-size);
  }
  .split {
    --cols: var(--num-w) minmax(0, 1fr) var(--num-w) minmax(0, 1fr);
  }
  .unified {
    --cols: var(--num-w) var(--num-w) minmax(0, 1fr);
  }

  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    outline: none;
    overscroll-behavior: contain;
  }
  .inline {
    height: auto;
  }
  .inline .scroller {
    flex: none;
    overflow: hidden;
    overscroll-behavior: auto;
  }
  .sizer {
    position: relative;
  }

  .row {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
  .line {
    display: grid;
    grid-template-columns: var(--cols);
    height: 20px;
    line-height: 20px;
  }

  .num {
    padding: 0 10px 0 8px;
    text-align: right;
    color: var(--fg-subtle);
    white-space: nowrap;
    overflow: hidden;
  }
  .num.add {
    background: var(--add-num);
    color: var(--fg);
  }
  .num.del {
    background: var(--del-num);
    color: var(--fg);
  }
  .num.empty {
    background: var(--empty-cell);
  }
  a.num {
    text-decoration: none;
    cursor: pointer;
  }
  a.num:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .split .num.right {
    border-left: 1px solid var(--border-muted);
  }

  .code {
    display: flex;
    min-width: 0;
    overflow: hidden;
  }
  .code.add {
    background: var(--add-line);
  }
  .code.del {
    background: var(--del-line);
  }
  .code.empty {
    background: var(--empty-cell);
  }
  .sign {
    flex: none;
    width: 2ch;
    padding-left: 4px;
    box-sizing: content-box;
    color: var(--fg-muted);
  }
  .clip {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .text {
    white-space: pre;
    tab-size: 4;
    padding-right: 16px;
    width: max-content;
    min-width: 100%;
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
  }
  .sel-old .code[data-side="new"] .text,
  .sel-new .code[data-side="old"] .text {
    user-select: none;
    -webkit-user-select: none;
  }

  .text {
    color: var(--code-fg);
  }
  .tok {
    color: var(--l);
  }
  :global([data-theme="dark"]) .tok {
    color: var(--d);
  }
  .tok.it {
    font-style: italic;
  }
  .tok.bd {
    font-weight: 600;
  }
  .del .tok.hl {
    background: var(--del-word);
    border-radius: 2px;
  }
  .add .tok.hl {
    background: var(--add-word);
    border-radius: 2px;
  }

  .expander {
    display: flex;
    align-items: stretch;
    background: var(--hunk-bg);
    color: var(--hunk-fg);
  }
  .expand-buttons {
    display: flex;
    flex-direction: column;
    width: var(--num-w);
    flex: none;
    background: var(--hunk-num);
  }
  .unified .expand-buttons {
    width: calc(var(--num-w) * 2);
  }
  .expand-buttons button {
    flex: 1;
    border: none;
    background: transparent;
    padding: 0;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    color: var(--fg-muted);
  }
  .expand-buttons button:hover {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .hunk-header {
    display: flex;
    align-items: center;
    padding: 0 10px;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .wrap .line {
    height: auto;
    min-height: 20px;
  }
  .wrap .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    width: auto;
    min-width: 0;
    padding-right: 0;
  }
  .probe {
    visibility: hidden;
    pointer-events: none;
  }
  .char-probe {
    position: absolute;
    white-space: pre;
  }
  .hscroll {
    flex: none;
    display: grid;
    grid-template-columns: var(--cols);
    border-top: 1px solid var(--border-muted);
    background: var(--bg-subtle);
  }
  .hbar {
    overflow-x: auto;
    overflow-y: hidden;
    height: 12px;
  }
  .hbar-inner {
    height: 1px;
  }
  .num-spacer {
    height: 12px;
  }
</style>
