<script lang="ts">
  let { onclose }: { onclose: () => void } = $props();

  const groups: [string, [string[], string][]][] = [
    [
      "Files",
      [
        [["Tab", "]"], "Next file (or guide step)"],
        [["⇧ Tab", "["], "Previous file (or step)"],
        [["/"], "Filter files"],
        [["a"], "Files / review guide"],
        [["o"], "Open file in editor"],
        [["b"], "Toggle sidebar"],
      ],
    ],
    [
      "Diff",
      [
        [["n"], "Next change"],
        [["p"], "Previous change"],
        [["j", "↓"], "Scroll down"],
        [["k", "↑"], "Scroll up"],
        [["Space"], "Page down"],
        [["g", "G"], "Top / bottom"],
      ],
    ],
    [
      "View",
      [
        [["s"], "Split / unified"],
        [["w"], "Hide whitespace"],
        [["z"], "Wrap long lines"],
        [["t"], "Theme: system / light / dark"],
        [["r"], "Reload"],
        [["q"], "Close window"],
        [["?"], "Show shortcuts"],
      ],
    ],
  ];
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="dialog" role="dialog" aria-label="Keyboard shortcuts" tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <h2>Keyboard shortcuts</h2>
    <div class="groups">
      {#each groups as [title, items]}
        <section>
          <h3>{title}</h3>
          {#each items as [keys, label]}
            <div class="item">
              <span class="keys">
                {#each keys as k}<kbd>{k}</kbd>{/each}
              </span>
              <span>{label}</span>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.35);
    z-index: 10;
  }
  .dialog {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  h2 {
    margin: 0 0 16px;
    font-size: 15px;
  }
  .groups {
    display: flex;
    gap: 32px;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 26px;
    font-size: 12.5px;
  }
  .keys {
    display: flex;
    gap: 4px;
    min-width: 84px;
  }
</style>
