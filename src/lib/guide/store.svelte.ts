// State of the review guide: which agent is connected, the guide for the
// current diff, and the agent job that is running.

import { aiAgents, aiCancel, aiRun, guideLoad, guideSave, settingsLoad, settingsSave, type AgentInfo } from "../git/api";
import { DEFAULT_INSTRUCTIONS, fullJob, parseGuide, syncGuide, type AgentJob, type AgentKind, type Guide } from "./guide";
import type { ChangeItem } from "./items";

export const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };

interface Settings {
  agent: AgentKind | null;
  model: string;
  /** Custom grouping and writing instructions for the prompt; null uses the default. */
  instructions: string | null;
}

/** Settings from before they were saved on disk, when they lived in the window's storage. */
function legacySettings(): Settings | null {
  try {
    const agent = localStorage.getItem("aiAgent");
    if (agent === null) return null;
    return { agent: JSON.parse(agent), model: JSON.parse(localStorage.getItem("aiModel") ?? '""'), instructions: null };
  } catch {
    return null;
  }
}

function parseSettings(text: string | null): Settings | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as Partial<Settings>;
    const agent = s.agent === "claude" || s.agent === "codex" ? s.agent : null;
    return {
      agent,
      model: typeof s.model === "string" ? s.model : "",
      instructions: typeof s.instructions === "string" && s.instructions.trim() ? s.instructions : null,
    };
  } catch {
    return null;
  }
}

class GuideStore {
  /** Agent CLIs found on this machine (null until detected). */
  agents = $state.raw<AgentInfo[] | null>(null);
  /** The agent the user connected, if any. Saved on disk, so the built app and dev mode share it. */
  agent = $state<AgentKind | null>(null);
  /** Model to ask for; empty uses the CLI's default. */
  model = $state<string>("");
  /** Custom prompt instructions; null uses DEFAULT_INSTRUCTIONS. */
  instructions = $state<string | null>(null);

  guide = $state.raw<Guide | null>(null);
  items = $state.raw<ChangeItem[]>([]);
  byKey = $derived(new Map(this.items.map((it) => [it.key, it])));

  /** What the agent is doing. */
  busy = $state<"generating" | "updating" | null>(null);
  startedAt = $state(0);
  error = $state<string | null>(null);
  /** The guide no longer matches the diff, and there is no agent to update it. */
  stale = $state(false);
  /** A saved guide was dropped because none of its changes are in the diff any more. */
  discarded = $state(false);

  /** The connected agent, if its CLI is installed. */
  connected = $derived.by((): AgentKind | null => {
    const a = this.agent;
    if (!a || !this.agents) return null;
    return this.agents.find((x) => x.kind === a)?.path ? a : null;
  });

  #ready: Promise<void> | null = null;
  #run = 0;
  /** The job that failed, to retry it. */
  #failed: AgentJob | null = null;
  /** The keys of `items`, to tell a reload with the same diff from a changed one. */
  #itemKeys = "";

  /** Detects agents and loads the settings and the cached guide. Safe to call more than once. */
  init(): Promise<void> {
    return (this.#ready ??= (async () => {
      const [agents, cached, saved] = await Promise.all([
        aiAgents().catch(() => []),
        guideLoad().catch(() => null),
        settingsLoad().catch(() => null),
      ]);
      this.agents = agents;
      this.guide = parseGuide(cached);
      const settings = parseSettings(saved) ?? legacySettings();
      if (settings) {
        this.agent = settings.agent;
        this.model = settings.model;
        this.instructions = settings.instructions;
      }
    })());
  }

  /** Saves the agent settings. Empty or default instructions are stored as null. */
  connect(agent: AgentKind | null, model = this.model, instructions = this.instructions) {
    this.agent = agent;
    this.model = model.trim();
    const custom = instructions?.trim();
    this.instructions = custom && custom !== DEFAULT_INSTRUCTIONS.trim() ? instructions : null;
    const settings: Settings = { agent, model: this.model, instructions: this.instructions };
    settingsSave(JSON.stringify(settings)).catch((e) =>
      console.error("could not save the settings", e),
    );
    // An out-of-date guide can be updated now.
    if (agent && this.stale) this.sync();
  }

  /** Called with the diff's items after every (re)load: keeps the guide in sync. */
  async setItems(items: ChangeItem[]) {
    await this.init();
    const keys = items.map((it) => it.key).join(",");
    const same = keys === this.#itemKeys;
    this.items = items;
    this.#itemKeys = keys;
    // Same diff (e.g. toggling whitespace) while the agent works: let it finish.
    if (same && this.busy) return;
    this.sync();
  }

  sync() {
    const g = this.guide;
    if (!g) return;
    const agent = this.connected;
    const s = syncGuide(g, this.items, agent ?? g.agent, this.instructions);
    if (s.kind === "current") {
      this.stale = false;
      return;
    }
    if (s.kind === "discard") {
      this.discard();
      this.discarded = true;
      return;
    }
    // Show the guide without the changes that are gone right away; the agent
    // then places the new changes and refreshes what needs it.
    if (s.guide !== g) this.#set(s.guide);
    if (!s.job) {
      this.stale = false;
      return;
    }
    if (!agent) {
      this.#cancelRunning();
      this.stale = true;
      return;
    }
    this.#start(s.job, agent);
  }

  /** Writes the guide again from scratch, replacing any update in progress. */
  generate() {
    const agent = this.connected;
    if (!agent || this.items.length === 0) return;
    this.discarded = false;
    this.#start(fullJob(this.items, agent, this.instructions), agent);
  }

  /** Runs the job that failed again. */
  retry() {
    const agent = this.connected;
    if (this.#failed && agent) this.#start(this.#failed, agent);
    else this.sync();
  }

  cancel() {
    if (!this.busy) return;
    this.#cancelRunning();
    aiCancel().catch(() => {});
  }

  /** Deletes the guide. */
  discard() {
    this.cancel();
    this.error = null;
    this.stale = false;
    this.discarded = false;
    this.#set(null);
  }

  #cancelRunning() {
    this.#run++;
    this.busy = null;
  }

  async #start(job: AgentJob, agent: AgentKind) {
    const run = ++this.#run;
    this.busy = job.kind === "full" ? "generating" : "updating";
    this.startedAt = Date.now();
    this.error = null;
    this.#failed = null;
    try {
      const answer = await aiRun(agent, this.model || null, job.prompt, job.schema);
      if (run !== this.#run) return;
      this.stale = false;
      this.#set(job.apply(answer));
    } catch (e) {
      if (run !== this.#run) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.#failed = job;
    } finally {
      if (run === this.#run) this.busy = null;
    }
  }

  #set(guide: Guide | null) {
    this.guide = guide;
    guideSave(guide && JSON.stringify(guide)).catch((e) => console.error("could not save the guide", e));
  }
}

export const guideStore = new GuideStore();
