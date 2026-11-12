import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import type { DiffOutput, FileContent, SessionInfo, Side } from "../types";

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (import.meta.env.DEV && !isTauri()) {
    const { mockInvoke } = await import("./mock");
    return (await mockInvoke(cmd, args)) as T;
  }
  return tauriInvoke<T>(cmd, args);
}

export const getSession = () => invoke<SessionInfo>("get_session");

export const getDiff = (ignoreWhitespace: boolean) => invoke<DiffOutput>("get_diff", { ignoreWhitespace });

export const readFile = (side: Side, path: string, blob: string | null, base64 = false) =>
  invoke<FileContent>("read_file", { side, path, blob, base64 });

/** Absolute path of the file on disk to open in an editor, or null if there is none. */
export const editorTarget = (path: string) => invoke<string | null>("editor_target", { path });

export const openInEditor = (path: string, line: number) => invoke<void>("open_in_editor", { path, line });

// ---- AI review guides ----

export interface AgentInfo {
  kind: "claude" | "codex";
  /** Where the CLI is installed, or null if it was not found. */
  path: string | null;
}

export const aiAgents = () => invoke<AgentInfo[]>("ai_agents");

/**
 * Runs the agent in the repository and returns the JSON it answered with.
 * One agent runs per job (the guide's when null): a new run of a job cancels
 * the previous one.
 */
export const aiRun = (agent: AgentInfo["kind"], model: string | null, prompt: string, schema: object, job: string | null = null) =>
  invoke<unknown>("ai_run", { agent, model, prompt, schema, job });

/** Stops the agent running for a job (the guide's when null). */
export const aiCancel = (job: string | null = null) => invoke<void>("ai_cancel", { job });

/** The cached guide for this diff, as JSON text. */
export const guideLoad = () => invoke<string | null>("guide_load");

/** Saves (or, with null, deletes) the cached guide for this diff. */
export const guideSave = (data: string | null) => invoke<void>("guide_save", { data });

/** App settings shared by the built app and dev mode, as JSON text. */
export const settingsLoad = () => invoke<string | null>("settings_load");

export const settingsSave = (data: string) => invoke<void>("settings_save", { data });
