<script lang="ts">
  import { imageMime, loadSide } from "../content";
  import type { FileDiff, Side } from "../types";

  let { file }: { file: FileDiff } = $props();

  interface Img {
    src: string | null;
    size: number | null;
    width?: number;
    height?: number;
  }

  let images = $state<{ id: string; old: Img | null; new: Img | null } | null>(null);

  async function load(f: FileDiff, side: Side): Promise<Img | null> {
    const c = await loadSide(f, side, true);
    if (!c) return null;
    const mime = imageMime(f.path)!;
    if (c.content.kind === "binary" && c.content.base64) {
      return { src: `data:${mime};base64,${c.content.base64}`, size: c.content.size };
    }
    return { src: null, size: c.content.kind === "binary" || c.content.kind === "tooLarge" ? c.content.size : null };
  }

  $effect(() => {
    const f = file;
    let cancelled = false;
    Promise.all([load(f, "old"), load(f, "new")]).then(([o, n]) => {
      if (!cancelled) images = { id: f.id, old: o, new: n };
    });
    return () => {
      cancelled = true;
    };
  });

  function formatSize(bytes: number | null) {
    if (bytes === null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function onload(e: Event, img: Img) {
    const el = e.currentTarget as HTMLImageElement;
    img.width = el.naturalWidth;
    img.height = el.naturalHeight;
  }

  const current = $derived(images?.id === file.id ? images : null);
</script>

{#snippet pane(label: string, img: Img | null, cls: string)}
  <figure class="pane {cls}">
    <figcaption>
      <span class="label">{label}</span>
      {#if img}
        <span class="meta">
          {#if img.width}{img.width} × {img.height} · {/if}{formatSize(img.size)}
        </span>
      {/if}
    </figcaption>
    <div class="frame">
      {#if !img}
        <span class="none">No file</span>
      {:else if img.src}
        <img src={img.src} alt={label} onload={(e) => onload(e, img)} />
      {:else}
        <span class="none">Image too large to preview</span>
      {/if}
    </div>
  </figure>
{/snippet}

<div class="image-diff">
  {#if current}
    {@render pane("Before", current.old, "old")}
    {@render pane("After", current.new, "new")}
  {/if}
</div>

<style>
  .image-diff {
    display: flex;
    gap: 16px;
    padding: 16px;
    height: 100%;
    overflow: auto;
  }
  .pane {
    flex: 1;
    margin: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  figcaption {
    display: flex;
    justify-content: space-between;
    padding: 6px 10px;
    font-size: 12px;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border);
  }
  .old figcaption .label {
    color: var(--status-deleted);
  }
  .new figcaption .label {
    color: var(--status-added);
  }
  .meta {
    color: var(--fg-muted);
  }
  .frame {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    min-height: 200px;
    background-color: var(--bg);
    background-image:
      linear-gradient(45deg, var(--bg-inset) 25%, transparent 25%),
      linear-gradient(-45deg, var(--bg-inset) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--bg-inset) 75%),
      linear-gradient(-45deg, transparent 75%, var(--bg-inset) 75%);
    background-size: 16px 16px;
    background-position:
      0 0,
      0 8px,
      8px -8px,
      -8px 0;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .none {
    color: var(--fg-muted);
  }
</style>
