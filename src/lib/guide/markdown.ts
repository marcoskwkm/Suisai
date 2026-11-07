// A small Markdown renderer for guide explanations: paragraphs, lists, code
// blocks, inline code, bold and italics. Everything else is plain text, and
// all text is escaped, so the agent's output cannot inject HTML.
//
// ```mermaid blocks become diagram placeholders: they show the source until
// diagrams.ts draws them.

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  // Split out code spans first so their contents are left alone.
  return s
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>");
    })
    .join("");
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${tag}>`);
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const source = escape(code.join("\n"));
      if (fence[1].toLowerCase() === "mermaid") {
        out.push(`<div class="diagram" data-diagram="${source}"><pre><code>${source}</code></pre></div>`);
      } else {
        out.push(`<pre><code>${source}</code></pre>`);
      }
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const ordered = item[2] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[3]);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    // A wrapped line continues the current list item.
    if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      out.push(`<p><strong>${inline(heading[1])}</strong></p>`);
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join("");
}
