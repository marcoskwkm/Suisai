<script lang="ts">
  import { DEFAULT_INSTRUCTIONS, type AgentKind } from "../guide/guide";
  import { AGENT_NAMES, guideStore as gs } from "../guide/store.svelte";

  let { onclose }: { onclose: () => void } = $props();

  interface ModelOption {
    /** Passed to the CLI's --model. */
    value: string;
    label: string;
  }

  const INFO: Record<AgentKind, { what: string; install: string; models: ModelOption[]; customHint: string }> = {
    claude: {
      what: "Uses your Claude Code login (Claude subscription or API key).",
      install: "curl -fsSL https://claude.ai/install.sh | bash",
      // Aliases: Claude Code maps each to the latest version of that model.
      models: [
        { value: "opus", label: "Opus · most capable" },
        { value: "sonnet", label: "Sonnet · balanced" },
        { value: "haiku", label: "Haiku · fastest" },
        { value: "fable", label: "Fable · may need usage credits" },
      ],
      customHint: "A full model name, e.g. claude-sonnet-5-5",
    },
    codex: {
      what: "OpenAI's coding agent. Sign in with your ChatGPT account by running codex login.",
      install: "npm install -g @openai/codex",
      models: [],
      customHint: "A model name Codex accepts with --model",
    },
  };

  /** Menu value for "Custom…" (no CLI model is called this). */
  const CUSTOM = "__custom__";

  // svelte-ignore state_referenced_locally
  let choice = $state<AgentKind | null>(gs.agent);
  // The model menu and the custom name, for the agent the dialog opened with.
  // svelte-ignore state_referenced_locally
  const startModel = gs.model;
  const isPreset = (agent: AgentKind | null, m: string) => m === "" || (agent !== null && INFO[agent].models.some((o) => o.value === m));
  // svelte-ignore state_referenced_locally
  let modelChoice = $state(isPreset(gs.agent, startModel) ? startModel : CUSTOM);
  // svelte-ignore state_referenced_locally
  let customModel = $state(isPreset(gs.agent, startModel) ? "" : startModel);

  // A model picked for one agent means nothing to the other.
  // svelte-ignore state_referenced_locally
  let lastChoice = choice;
  $effect(() => {
    if (choice === lastChoice) return;
    lastChoice = choice;
    modelChoice = "";
    customModel = "";
  });

  // svelte-ignore state_referenced_locally
  let instructions = $state(gs.instructions ?? DEFAULT_INSTRUCTIONS);
  const isDefaultPrompt = $derived(instructions.trim() === DEFAULT_INSTRUCTIONS.trim());
  // svelte-ignore state_referenced_locally
  let promptOpen = $state(gs.instructions !== null);

  const pathOf = (k: AgentKind) => gs.agents?.find((a) => a.kind === k)?.path ?? null;

  function save() {
    const model = modelChoice === CUSTOM ? customModel.trim() : modelChoice;
    gs.connect(choice, model, instructions.trim() ? instructions : null);
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
      <div class="field">
        <label for="model-select">Model</label>
        <select id="model-select" bind:value={modelChoice}>
          <option value="">Default · {AGENT_NAMES[choice]}'s own setting</option>
          {#each INFO[choice].models as m (m.value)}
            <option value={m.value}>{m.label}</option>
          {/each}
          <option value={CUSTOM}>Custom…</option>
        </select>
        {#if modelChoice === CUSTOM}
          <input bind:value={customModel} placeholder={INFO[choice].customHint} spellcheck="false" autocomplete="off" />
        {/if}
      </div>

      <div class="field">
        <button class="disclosure" onclick={() => (promptOpen = !promptOpen)} aria-expanded={promptOpen}>
          <svg class:open={promptOpen} width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Prompt
          <span class="tag">{isDefaultPrompt ? "default" : "customized"}</span>
        </button>
        {#if promptOpen}
          <p class="hint">
            How the agent groups, orders and explains the changes. Suisai adds the diff, the ids of the changes and the format of the answer
            itself. Changes apply to new guides and updates; use Regenerate to rewrite an existing guide with them.
          </p>
          <textarea bind:value={instructions} rows="14" spellcheck="false"></textarea>
          <div class="prompt-actions">
            <button class="link" onclick={() => (instructions = DEFAULT_INSTRUCTIONS)} disabled={isDefaultPrompt}>Reset to default</button>
          </div>
        {/if}
      </div>
    {/if}

    <div class="buttons">
      <button class="secondary" onclick={onclose}>Cancel</button>
      <button class="primary" onclick={save} disabled={choice !== null && modelChoice === CUSTOM && !customModel.trim()}>Save</button>
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
    width: min(600px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow-y: auto;
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
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 14px;
    font-size: 12.5px;
  }
  .field > label {
    font-weight: 500;
  }
  select,
  .field input,
  textarea {
    padding: 5px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font-size: 13px;
    outline: none;
  }
  select:focus,
  .field input:focus,
  textarea:focus {
    border-color: var(--accent);
  }
  textarea {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
    min-height: 120px;
    user-select: text;
    -webkit-user-select: text;
  }
  .disclosure {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: none;
    background: none;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--fg);
    cursor: pointer;
    align-self: flex-start;
  }
  .disclosure svg {
    color: var(--fg-muted);
    transition: transform 0.12s ease;
  }
  .disclosure svg.open {
    transform: rotate(90deg);
  }
  .tag {
    font-size: 11px;
    font-weight: 400;
    color: var(--fg-muted);
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-muted);
  }
  .prompt-actions {
    display: flex;
    justify-content: flex-end;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
  }
  .link:disabled {
    color: var(--fg-subtle);
    cursor: default;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
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
