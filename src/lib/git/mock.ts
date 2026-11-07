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
    case "ai_agents":
      return [
        { kind: "claude", path: "/mock/claude" },
        { kind: "codex", path: null },
      ];
    case "ai_run":
      return mockGuideAnswer(String(args.prompt));
    case "guide_load":
      return null;
    case "guide_save":
    case "ai_cancel":
      return null;
  }
  throw new Error(`unknown command ${cmd}`);
}

/** A stand-in agent answer: groups the prompt's changes by top-level folder. */
async function mockGuideAnswer(prompt: string) {
  await new Promise((r) => setTimeout(r, 1500));
  const changes = [...prompt.matchAll(/^### ([cn]\d+) · (\S+)/gm)].map((m) => ({ id: m[1], dir: m[2].split("/")[0] }));
  const byDir = new Map<string, string[]>();
  for (const c of changes) byDir.set(c.dir, [...(byDir.get(c.dir) ?? []), c.id]);
  const groups = [...byDir].map(([dir, ids]) => ({
    title: `Changes in ${dir}`,
    explanation: `Mock explanation for \`${dir}\`.\n\n- First point with **bold** text\n- Second point`,
    changes: ids,
  }));
  if (prompt.includes("# Current guide")) {
    return { title: "", overview: "", groups: [{ id: "g1", title: "", explanation: "", newChanges: changes.map((c) => c.id) }] };
  }
  return { title: "Mock review guide", overview: "A mock guide made in the browser, without an agent.", groups };
}
