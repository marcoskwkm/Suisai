import { bundledLanguages } from "shiki";
import { describe, expect, it } from "vitest";
import { detectLanguage } from "./languages";

describe("detectLanguage", () => {
  it("resolves common files to bundled languages", () => {
    const cases: Record<string, string> = {
      "src/App.svelte": "svelte",
      "a/b/main.ts": "ts",
      "x.tsx": "tsx",
      "x.mjs": "javascript",
      "lib.rs": "rs",
      "main.go": "go",
      "x.py": "py",
      "Main.java": "java",
      "x.kt": "kt",
      "x.swift": "swift",
      "x.h": "c",
      "x.hpp": "cpp",
      "x.m": "objective-c",
      "style.scss": "scss",
      "README.md": "md",
      "config.yml": "yaml",
      "Cargo.toml": "toml",
      Dockerfile: "docker",
      "Dockerfile.dev": "docker",
      Makefile: "make",
      ".gitignore": "ini",
      ".env.local": "dotenv",
      "query.sql": "sql",
      "x.vue": "vue",
      "x.json": "json",
      "x.rb": "rb",
      "x.php": "php",
      "x.cs": "cs",
      "x.ex": "elixir",
      "main.tf": "terraform",
    };
    for (const [path, lang] of Object.entries(cases)) {
      expect(detectLanguage(path), path).toBe(lang);
      expect(lang in bundledLanguages, `${lang} is bundled`).toBe(true);
    }
  });

  it("uses shebangs for files without extensions", () => {
    expect(detectLanguage("bin/run", "#!/usr/bin/env bash")).toBe("shellscript");
    expect(detectLanguage("bin/tool", "#!/usr/bin/env python3")).toBe("python");
    expect(detectLanguage("bin/tool", "#!/usr/bin/env node")).toBe("javascript");
    expect(detectLanguage("bin/tool")).toBeNull();
  });

  it("only maps to languages Shiki bundles", async () => {
    const src = await import("./languages?raw");
    const ids = [...(src.default as string).matchAll(/:\s*"([a-z0-9+#-]+)"/g)].map((m) => m[1]);
    const missing = [...new Set(ids)].filter((id) => !(id in bundledLanguages));
    expect(missing).toEqual([]);
  });
});
