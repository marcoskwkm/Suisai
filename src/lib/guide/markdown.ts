// A small Markdown renderer for guide explanations and answers: paragraphs,
// headings, nested lists, tables, block quotes, rules, code blocks, inline
// code, bold, italics and strikethrough. Everything else is plain text, and
// all text is escaped, so the agent's output cannot inject HTML.
//
// ```mermaid blocks become diagram placeholders: they show the source until
// diagrams.ts draws them.

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  // Code spans and backslash escapes are set aside first, so their contents
  // are left alone and emphasis can wrap them (as in **`name`**).
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  return escape(
    s
      .replace(/\u0000/g, "")
      .replace(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_, _ticks, code: string) => hold(`<code>${escape(code.replace(/^ (.*) $/, "$1"))}</code>`))
      .replace(/\\([\\`*_~|#[\]()<>.!+-])/g, (_, c: string) => hold(escape(c))),
  )
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^_\w])__(?!\s)(.+?)(?<!\s)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, "<del>$1</del>")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]);
}

interface List {
  ordered: boolean;
  start: number;
  indent: number;
  items: { text: string; lists: List[] }[];
}

function renderList(list: List): string {
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
  const items = list.items.map((i) => `<li>${inline(i.text)}${i.lists.map(renderList).join("")}</li>`).join("");
  return `<${tag}${start}>${items}</${tag}>`;
}

/** A table row's cells, split on pipes outside code spans; `\|` is a literal pipe. */
function cells(row: string, spans = true): string[] {
  const out: string[] = [];
  let cell = "";
  let ticks = 0;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`" && spans) {
      let n = 1;
      while (row[i + n] === "`") n++;
      ticks = ticks === 0 ? n : ticks === n ? 0 : ticks;
      cell += row.slice(i, i + n);
      i += n - 1;
    } else if (c === "|" && !ticks) {
      out.push(cell);
      cell = "";
    } else {
      cell += c;
    }
  }
  // An unclosed code span is not one.
  if (ticks) return cells(row, false);
  out.push(cell);
  // Pipes at the ends of the row are optional.
  if (out.length > 1 && out[0].trim() === "") out.shift();
  if (out.length > 1 && out[out.length - 1].trim() === "") out.pop();
  return out.map((c) => c.trim());
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  /** The open lists, outermost first. */
  let lists: List[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (lists.length) out.push(renderList(lists[0]));
    lists = [];
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
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_DELIMITER.test(lines[i + 1])) {
      flushPara();
      flushList();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((d) => (d.startsWith(":") ? (d.endsWith(":") ? "center" : "left") : d.endsWith(":") ? "right" : null));
      const cell = (tag: string, text: string | undefined, col: number) =>
        `<${tag}${align[col] ? ` style="text-align: ${align[col]}"` : ""}>${inline(text ?? "")}</${tag}>`;
      const rows: string[] = [];
      for (i += 2; i < lines.length && lines[i].trim() !== "" && lines[i].includes("|"); i++) {
        const row = cells(lines[i]);
        rows.push(`<tr>${head.map((_, col) => cell("td", row[col], col)).join("")}</tr>`);
      }
      i--;
      const body = rows.length ? `<tbody>${rows.join("")}</tbody>` : "";
      out.push(`<div class="md-table"><table><thead><tr>${head.map((h, col) => cell("th", h, col)).join("")}</tr></thead>${body}</table></div>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flushPara();
      flushList();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s{0,3}> ?/, ""));
      i--;
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }
    const item = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, "    ").length;
      const ordered = item[3] !== undefined;
      // Close lists indented deeper than this item, and a list of the other kind at its level.
      while (lists.length > 1 && lists[lists.length - 1].indent > indent) lists.pop();
      let top = lists.at(-1);
      if (top && top.indent === indent && top.ordered !== ordered) {
        if (lists.length === 1) flushList();
        else lists.pop();
        top = lists.at(-1);
      }
      if (!top || top.indent < indent) {
        const list: List = { ordered, start: ordered ? Number(item[3]) : 1, indent, items: [] };
        top?.items[top.items.length - 1].lists.push(list);
        lists.push(list);
        top = list;
      }
      top.items.push({ text: item[4], lists: [] });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      // A blank line between items does not end the list.
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      if (!lists.length || !next || !/^\s*(?:[-*+]|\d+[.)])\s+/.test(next)) flushList();
      continue;
    }
    // A wrapped line continues the current list item.
    if (lists.length && /^\s+/.test(line)) {
      const items = lists[lists.length - 1].items;
      items[items.length - 1].text += " " + line.trim();
      continue;
    }
    flushList();
    const heading = /^#{1,6}\s+(.*?)(\s+#+)?\s*$/.exec(line);
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
