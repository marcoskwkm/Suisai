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
