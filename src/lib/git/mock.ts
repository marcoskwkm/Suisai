// Browser-only stand-in for the Tauri backend, used by `pnpm dev` outside the
// app. Data comes from dev/mock.json (see scripts/record-mock.ts).
import type { DiffOutput, FileContent, SessionInfo, Side } from "../types";

interface Mock {
  session: SessionInfo;
  patch: string;
  wsPatch: string;
  files: Record<string, FileContent>;
}

let data: Promise<Mock> | null = null;
const load = () =>
  (data ??= fetch("/dev/mock.json").then((r) => {
    if (!r.ok) throw new Error("No dev/mock.json. Record one with: node scripts/record-mock.ts <repo> [git diff args]");
    return r.json();
  }));

export async function mockInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const m = await load();
  switch (cmd) {
    case "get_session":
      return m.session;
    case "get_diff":
      return { patch: m.patch, ignoreWhitespacePatch: args.ignoreWhitespace ? m.wsPatch : null } satisfies DiffOutput;
    case "read_file": {
      const key = [args.side as Side, args.path, args.blob ?? "", Boolean(args.base64)].join("\u0000");
      return m.files[key] ?? { kind: "missing" };
    }
    case "editor_target":
      return null;
  }
  throw new Error(`unknown command ${cmd}`);
}
