import type { FileDiff } from "./types";

export interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  file: FileDiff;
}

export type TreeNode = DirNode | FileNode;

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

function sortNodes(nodes: TreeNode[]) {
  nodes.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  for (const n of nodes) if (n.kind === "dir") sortNodes(n.children);
}

/** Merges chains of single-child directories: "src" > "lib" becomes "src/lib". */
function compress(node: DirNode): DirNode {
  node.children = node.children.map((c) => (c.kind === "dir" ? compress(c) : c));
  if (node.path !== "" && node.children.length === 1 && node.children[0].kind === "dir") {
    const child = node.children[0];
    return { ...child, name: `${node.name}/${child.name}` };
  }
  return node;
}

export function buildTree(files: FileDiff[]): TreeNode[] {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = dir.children.find((c): c is DirNode => c.kind === "dir" && c.path === path);
      if (!next) {
        next = { kind: "dir", name: parts[i], path, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name: parts[parts.length - 1], path: file.path, file });
  }
  sortNodes(root.children);
  return compress(root).children;
}

/** Visible rows of the tree, skipping the contents of collapsed directories. */
export function flatten(nodes: TreeNode[], collapsed: Set<string>, depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "dir" && !collapsed.has(node.path)) flatten(node.children, collapsed, depth + 1, out);
  }
  return out;
}

/** All files in tree order (used for next/previous file). */
export function fileOrder(nodes: TreeNode[], out: FileDiff[] = []): FileDiff[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n.file);
    else fileOrder(n.children, out);
  }
  return out;
}
