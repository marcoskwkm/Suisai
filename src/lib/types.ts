export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";
export type LineType = "context" | "add" | "del";
export type Side = "old" | "new";
export type ViewMode = "split" | "unified";

export interface DiffLine {
  type: LineType;
  /** Text as printed by git (without the leading +/-/space). */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The raw `@@ ... @@ heading` line. */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Stable identity: old and new path. */
  id: string;
  oldPath: string | null;
  newPath: string | null;
  /** Path shown in the UI (new path, or old path for deletions). */
  path: string;
  status: FileStatus;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  oldBlob: string | null;
  newBlob: string | null;
  similarity: number | null;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** Set when whitespace is hidden and this file only had whitespace changes. */
  whitespaceOnly?: boolean;
}

/** A syntax-highlighted token: text plus light/dark colors and font style bits. */
export interface Token {
  t: string;
  l?: string;
  d?: string;
  /** 1 = italic, 2 = bold, 4 = underline */
  f?: number;
}

export type FileContent =
  | { kind: "text"; text: string }
  | { kind: "binary"; size: number; base64: string | null }
  | { kind: "tooLarge"; size: number }
  | { kind: "missing" };

export interface SessionInfo {
  title: string;
  subtitle: string;
  mode: "repo" | "paths";
  leftRoot: string | null;
  rightRoot: string | null;
  fileName: string | null;
  error: string | null;
}

export interface DiffOutput {
  patch: string;
  ignoreWhitespacePatch: string | null;
}
