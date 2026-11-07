// State of the review guide: which agent is connected, the guide for the
// current diff, and the agent job that is running.

import { aiAgents, aiCancel, aiRun, guideLoad, guideSave, type AgentInfo } from "../git/api";
import { fullJob, parseGuide, syncGuide, type AgentJob, type AgentKind, type Guide } from "./guide";
import type { ChangeItem } from "./items";

export const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

class GuideStore {
  /** Agent CLIs found on this machine (null until detected). */
  agents = $state.raw<AgentInfo[] | null>(null);
  /** The agent the user connected, if any. */
  agent = $state<AgentKind | null>(read("aiAgent", null));
  /** Model to ask for; empty uses the CLI's default. */
  model = $state<string>(read("aiModel", ""));

  guide = $state.raw<Guide | null>(null);
  items = $state.raw<ChangeItem[]>([]);
  byKey = $derived(new Map(this.items.map((it) => [it.key, it])));

  /** What the agent is doing. */
  busy = $state<"generating" | "updating" | null>(null);
  startedAt = $state(0);
  error = $state<string | null>(null);
  /** The guide no longer matches the diff, and there is no agent to update it. */
  stale = $state(false);

  /** The connected agent, if its CLI is installed. */
  connected = $derived.by((): AgentKind | null => {
    const a = this.agent;
    if (!a || !this.agents) return null;
    return this.agents.find((x) => x.kind === a)?.path ? a : null;
  });

  #ready: Promise<void> | null = null;
  #run = 0;

  /** Detects agents and loads the cached guide. Safe to call more than once. */
  init(): Promise<void> {
    return (this.#ready ??= (async () => {
      const [agents, cached] = await Promise.all([aiAgents().catch(() => []), guideLoad().catch(() => null)]);
      this.agents = agents;
      this.guide = parseGuide(cached);
    })());
  }

  connect(agent: AgentKind | null, model = this.model) {
    this.agent = agent;
    this.model = model.trim();
    write("aiAgent", agent);
    write("aiModel", this.model);
    // An out-of-date guide can be updated now.
    if (agent && this.stale) this.sync();
  }

  /** Called with the diff's items after every (re)load: keeps the guide in sync. */
  async setItems(items: ChangeItem[]) {
    await this.init();
    this.items = items;
    this.sync();
  }

  sync() {
    const g = this.guide;
    if (!g) return;
    const agent = this.connected;
    const s = syncGuide(g, this.items, agent ?? g.agent);
    if (s.kind === "current") {
      this.stale = false;
      return;
    }
    if (s.kind === "pruned") {
      // Show the guide without the removed changes now; the agent then
      // refreshes the explanations of the groups that lost some.
      this.#cancelRunning();
      this.#set(s.guide);
      this.stale = s.job !== null && !agent;
      if (s.job && agent) this.#start(s.job, agent);
      return;
    }
    if (!agent) {
      this.stale = true;
      return;
    }
    this.#start(s.job, agent);
  }

  generate() {
    const agent = this.connected;
    if (!agent || this.items.length === 0) return;
    this.#start(fullJob(this.items, agent), agent);
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
    try {
      const answer = await aiRun(agent, this.model || null, job.prompt, job.schema);
      if (run !== this.#run) return;
      this.stale = false;
      this.#set(job.apply(answer));
    } catch (e) {
      if (run !== this.#run) return;
      this.error = e instanceof Error ? e.message : String(e);
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
