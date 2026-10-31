import { describe, expect, it } from "vitest";
import { buildTree, fileOrder, flatten } from "./tree";
import type { FileDiff } from "./types";

const f = (path: string) => ({ path, id: path }) as FileDiff;

describe("tree", () => {
  const tree = buildTree([f("src/lib/a.ts"), f("src/lib/b.ts"), f("README.md"), f("src/main.ts"), f("docs/guide/x.md")]);

  it("sorts directories first and compresses single-child chains", () => {
    const rows = flatten(tree, new Set()).map((r) => `${"  ".repeat(r.depth)}${r.node.name}`);
    expect(rows).toEqual(["docs/guide", "  x.md", "src", "  lib", "    a.ts", "    b.ts", "  main.ts", "README.md"]);
  });

  it("hides collapsed directories", () => {
    expect(flatten(tree, new Set(["src"])).map((r) => r.node.name)).toEqual(["docs/guide", "x.md", "src", "README.md"]);
  });

  it("orders files like the tree", () => {
    expect(fileOrder(tree).map((x) => x.path)).toEqual(["docs/guide/x.md", "src/lib/a.ts", "src/lib/b.ts", "src/main.ts", "README.md"]);
  });
});
