// Questions asked about lines of the guide, for this session only. Each
// thread runs as its own agent job, so questions do not stop each other or
// the guide's updates.

import { aiCancel, aiRun } from "../git/api";
import type { DiffLine, FileDiff } from "../types";
import { ANSWER_SCHEMA, parseAnswer, questionPrompt, type Thread } from "./questions";
import { guideStore as gs } from "./store.svelte";

const newId = () => Math.random().toString(36).slice(2, 10);
const jobOf = (id: string) => `question:${id}`;

class QuestionStore {
  threads = $state.raw<Thread[]>([]);
  /** The questions panel is shown. */
  open = $state(false);
  /** The thread whose lines are highlighted in the diff. */
  active = $state<string | null>(null);
  /** Text typed but not sent yet, by thread id (kept when the step changes). */
  drafts = new Map<string, string>();

  /** The current guide's threads in a step, oldest first. */
  forStep(groupId: string): Thread[] {
    const created = gs.guide?.createdAt;
    return this.threads.filter((t) => t.guide === created && t.groupId === groupId);
  }

  /** Starts a thread about lines of a step's file and opens the panel on it. */
  start(groupId: string, file: FileDiff, lines: DiffLine[]): string | null {
    const guide = gs.guide;
    if (!guide || lines.length === 0) return null;
    const id = newId();
    const thread: Thread = { id, guide: guide.createdAt, groupId, file, lines, exchanges: [], startedAt: null, error: null };
    // Threads never asked are dropped, unless something was typed in them.
    this.threads = [...this.threads.filter((t) => t.exchanges.length || this.drafts.get(t.id)?.trim()), thread];
    this.open = true;
    this.active = id;
    return id;
  }

  ask(id: string, question: string) {
    const q = question.trim();
    const t = this.#get(id);
    if (!q || !t || t.startedAt !== null) return;
    this.drafts.delete(id);
    this.#update(id, { exchanges: [...t.exchanges, { question: q, answer: null }] });
    this.#run(id);
  }

  /** Asks the last question again after an error. */
  retry(id: string) {
    const t = this.#get(id);
    if (t?.exchanges.at(-1)?.answer === null) this.#run(id);
  }

  /** Stops the agent and puts the question back in the text box. */
  cancel(id: string) {
    const t = this.#get(id);
    const last = t?.exchanges.at(-1);
    if (!t || !last || last.answer !== null) return;
    aiCancel(jobOf(id)).catch(() => {});
    this.drafts.set(id, last.question);
    this.#update(id, { exchanges: t.exchanges.slice(0, -1), startedAt: null, error: null });
  }

  remove(id: string) {
    if (this.#get(id)?.startedAt !== null) aiCancel(jobOf(id)).catch(() => {});
    this.drafts.delete(id);
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.active === id) this.active = null;
  }

  async #run(id: string) {
    const t = this.#get(id);
    const guide = gs.guide;
    const group = guide?.groups.find((g) => g.id === t?.groupId);
    const agent = gs.connected;
    if (!t || !guide || !group) return;
    if (!agent) {
      this.#update(id, { error: "Connect an AI agent in the agent settings to ask questions." });
      return;
    }
    const startedAt = Date.now();
    this.#update(id, { startedAt, error: null });
    let answer: string | null = null;
    let error: string | null = null;
    try {
      answer = parseAnswer(await aiRun(agent, gs.model || null, questionPrompt(guide, group, t), ANSWER_SCHEMA, jobOf(id)));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // Cancelled, removed, or asked again meanwhile.
    const now = this.#get(id);
    if (!now || now.startedAt !== startedAt) return;
    const exchanges = answer === null ? now.exchanges : [...now.exchanges.slice(0, -1), { ...now.exchanges.at(-1)!, answer }];
    this.#update(id, { exchanges, startedAt: null, error });
  }

  #get(id: string): Thread | undefined {
    return this.threads.find((t) => t.id === id);
  }

  #update(id: string, patch: Partial<Thread>) {
    this.threads = this.threads.map((t) => (t.id === id ? { ...t, ...patch } : t));
  }
}

export const questionStore = new QuestionStore();
