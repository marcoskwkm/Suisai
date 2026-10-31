/**
 * Records a git diff (and the file contents it needs) to dev/mock.json so the
 * UI can run in a plain browser with `pnpm dev`, without Tauri.
 *
 *   node scripts/record-mock.ts <repo> [git diff args...]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parsePatch } from "../src/lib/git/parse.ts";

const [repo = ".", ...args] = process.argv.slice(2);
const git = (a: string[], opts: { encoding?: null } = {}) =>
  execFileSync("git", a, { cwd: repo, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"], ...opts } as never) as unknown as Buffer;

const base = [
  "-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
  "--full-index", "-M", "--src-prefix=a/", "--dst-prefix=b/",
];
const patch = git([...base, ...args]).toString("utf8");
const wsPatch = git([...base, "-w", ...args]).toString("utf8");
const root = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const files: Record<string, unknown> = {};

function read(path: string, blob: string | null): Buffer | null {
  if (blob && /^0+$/.test(blob)) return null;
  if (blob) {
    try {
      return git(["cat-file", "blob", blob]);
    } catch {
      // working tree
    }
  }
  const p = join(root, path);
  return existsSync(p) ? readFileSync(p) : null;
}

for (const f of parsePatch(patch)) {
  for (const side of ["old", "new"] as const) {
    const path = side === "old" ? f.oldPath : f.newPath;
    const blob = side === "old" ? f.oldBlob : f.newBlob;
    if (path === null) continue;
    const bytes = read(path, blob);
    const image = IMAGE.test(path);
    const key = [side, path, blob ?? "", image].join("\u0000");
    if (!bytes) files[key] = { kind: "missing" };
    else if (bytes.subarray(0, 8000).includes(0) || image)
      files[key] = { kind: "binary", size: bytes.length, base64: image ? bytes.toString("base64") : null };
    else files[key] = { kind: "text", text: bytes.toString("utf8") };
  }
}

const session = {
  title: basename(root),
  subtitle: ["git diff", ...args].join(" "),
  mode: "repo",
  leftRoot: null,
  rightRoot: null,
  fileName: null,
  error: null,
};
mkdirSync("dev", { recursive: true });
writeFileSync("dev/mock.json", JSON.stringify({ session, patch, wsPatch, files }));
console.log(`Recorded ${parsePatch(patch).length} files to dev/mock.json`);
