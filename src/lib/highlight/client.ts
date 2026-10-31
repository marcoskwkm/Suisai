import type { Token } from "../types";
import type { HighlightRequest, HighlightResponse, PreloadRequest } from "./worker";

/** Files bigger than this are shown without syntax highlighting. */
export const MAX_HIGHLIGHT_CHARS = 500_000;
export const MAX_HIGHLIGHT_LINES = 15_000;

interface Job {
  key: string;
  code: string;
  lang: string;
  resolve: (lines: Token[][] | null) => void;
}

let worker: Worker | null = null;
let nextId = 1;
/** The job the worker is busy with (it handles one at a time). */
let running: { id: number; job: Job } | null = null;
/** Waiting jobs; the front is sent next. */
const queue: Job[] = [];
const cache = new Map<string, Promise<Token[][] | null>>();
const CACHE_SIZE = 200;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
      if (running?.id === e.data.id) {
        running.job.resolve(e.data.lines);
        running = null;
      }
      pump();
    };
    worker.onerror = (e) => {
      console.error("highlight worker failed:", e.message);
      running?.job.resolve(null);
      running = null;
      for (const job of queue.splice(0)) job.resolve(null);
    };
  }
  return worker;
}

function pump() {
  if (running || queue.length === 0) return;
  const job = queue.shift()!;
  const id = nextId++;
  running = { id, job };
  getWorker().postMessage({ id, code: job.code, lang: job.lang } satisfies HighlightRequest);
}

/**
 * Highlights a whole file in a worker. Resolves to one token list per line.
 * Background requests (prefetching) run after everything else.
 */
export function highlight(key: string, code: string, lang: string, background = false): Promise<Token[][] | null> {
  const hit = cache.get(key);
  if (hit) {
    // Someone is waiting for it now: move it ahead of the background work.
    const i = queue.findIndex((j) => j.key === key);
    if (!background && i > 0) queue.unshift(...queue.splice(i, 1));
    return hit;
  }
  const promise = new Promise<Token[][] | null>((resolve) => {
    const job = { key, code, lang, resolve };
    if (background) queue.push(job);
    else queue.unshift(job);
  });
  cache.set(key, promise);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  pump();
  return promise;
}

/**
 * Starts the highlighter and loads these languages in the background, so the
 * first file opened is colored right away.
 */
export function preloadLanguages(langs: Iterable<string>) {
  getWorker().postMessage({ preload: [...new Set(langs)] } satisfies PreloadRequest);
}

export function clearHighlightCache() {
  cache.clear();
  for (const job of queue.splice(0)) job.resolve(null);
}
