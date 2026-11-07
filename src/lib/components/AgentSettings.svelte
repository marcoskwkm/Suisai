<script lang="ts">
  import type { AgentKind } from "../guide/guide";
  import { AGENT_NAMES, guideStore as gs } from "../guide/store.svelte";

  let { onclose }: { onclose: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let choice = $state<AgentKind | null>(gs.agent);
  // svelte-ignore state_referenced_locally
  let model = $state(gs.model);

  const INFO: Record<AgentKind, { what: string; install: string; models: string }> = {
    claude: {
      what: "Uses your Claude Code login (Claude subscription or API key).",
      install: "curl -fsSL https://claude.ai/install.sh | bash",
      models: "e.g. opus, sonnet, haiku",
    },
    codex: {
      what: "OpenAI's coding agent. Sign in with your ChatGPT account by running codex login.",
      install: "npm install -g @openai/codex",
      models: "e.g. gpt-5-codex",
    },
  };

  const pathOf = (k: AgentKind) => gs.agents?.find((a) => a.kind === k)?.path ?? null;

  function save() {
    gs.connect(choice, model);
    onclose();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose} {onkeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="dialog" role="dialog" aria-label="AI agent" tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <h2>AI agent for review guides</h2>
    <p class="lead">
      Suisai runs the agent's command line tool on this computer, in the repository, with read-only access. The diff is sent to the
      agent's service.
    </p>

    <div class="options">
      {#each ["claude", "codex"] as const as k}
        {@const path = pathOf(k)}
        <label class="option" class:disabled={!path} class:active={choice === k}>
          <input type="radio" name="agent" value={k} bind:group={choice} disabled={!path} />
          <span class="text">
            <span class="name">{AGENT_NAMES[k]}</span>
            <span class="desc">{INFO[k].what}</span>
            {#if path}
              <span class="found">Found at <code>{path}</code></span>
            {:else if gs.agents === null}
              <span class="desc">Looking…</span>
            {:else}
              <span class="missing">Not installed. Install it with <code>{INFO[k].install}</code>, then restart Suisai.</span>
            {/if}
          </span>
        </label>
      {/each}
      <label class="option" class:active={choice === null}>
        <input type="radio" name="agent" value={null} bind:group={choice} />
        <span class="text">
          <span class="name">None</span>
          <span class="desc">Disconnect. Existing guides stay visible but are not updated.</span>
        </span>
      </label>
    </div>

    {#if choice}
      <label class="model">
        <span>Model <span class="optional">(optional)</span></span>
        <input bind:value={model} placeholder="Default: {INFO[choice].models}" spellcheck="false" autocomplete="off" />
      </label>
    {/if}

    <div class="buttons">
      <button class="secondary" onclick={onclose}>Cancel</button>
      <button class="primary" onclick={save}>Save</button>
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
    width: min(520px, calc(100vw - 32px));
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 15px;
  }
  .lead {
    margin: 0 0 14px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--fg-muted);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .option {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
  }
  .option.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  .option.disabled {
    cursor: default;
  }
  .option input {
    margin: 2px 0 0;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    font-size: 13px;
  }
  .disabled .name {
    color: var(--fg-muted);
  }
  .desc,
  .found,
  .missing {
    font-size: 12px;
    line-height: 1.45;
    color: var(--fg-muted);
  }
  .missing code,
  .found code {
    font-family: var(--font-mono);
    font-size: 11px;
    word-break: break-all;
    user-select: text;
    -webkit-user-select: text;
  }
  .model {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 14px;
    font-size: 12.5px;
    font-weight: 500;
  }
  .optional {
    color: var(--fg-muted);
    font-weight: 400;
  }
  .model input {
    padding: 5px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font-size: 13px;
    outline: none;
  }
  .model input:focus {
    border-color: var(--accent);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  .primary,
  .secondary {
    padding: 5px 14px;
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
  .secondary {
    border: 1px solid var(--border);
    background: var(--bg);
  }
</style>
