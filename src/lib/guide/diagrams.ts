// Draws the Mermaid diagrams and charts in guide explanations. renderMarkdown
// turns ```mermaid blocks into `.diagram` placeholders holding the source;
// the `diagrams` action replaces each with its drawing.
//
// Mermaid is large, so it is loaded the first time a diagram is shown. It
// runs with securityLevel "strict": diagrams come from the agent, so labels
// are sanitized and click handlers and scripts are disabled.

import type { Mermaid } from "mermaid";

type Theme = "light" | "dark";

let mermaid: Promise<Mermaid> | null = null;

/** Diagram types whose `useMaxWidth` is turned off (charts are configured separately). */
const NATURAL_SIZE = ["flowchart", "sequence", "class", "state", "er", "gantt", "journey", "timeline", "mindmap", "quadrantChart", "sankey", "requirement", "gitGraph", "block", "architecture", "packet", "kanban", "radar"];
let configured: Theme | null = null;

function load(): Promise<Mermaid> {
  return (mermaid ??= import("mermaid").then((m) => m.default));
}

/** Drawn SVGs by theme and source, so switching steps does not draw them again. */
const cache = new Map<string, Promise<string>>();
/** Mermaid draws in a shared scratch element: one diagram at a time. */
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

/** Mermaid colors from the app's own (see app.css), so diagrams match the UI. */
function themeVariables(theme: Theme) {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const [bg, subtle, inset, border, fg, muted, accent] = ["--bg", "--bg-subtle", "--bg-inset", "--border", "--fg", "--fg-muted", "--accent"].map(v);
  const palette = [accent, v("--status-added"), v("--status-modified"), v("--status-deleted"), v("--status-renamed"), muted];
  return {
    darkMode: theme === "dark",
    fontSize: "13px",
    background: bg,
    textColor: fg,
    lineColor: muted,
    // Boxes, and the shapes of other diagram types derived from them.
    primaryColor: subtle,
    primaryTextColor: fg,
    primaryBorderColor: accent,
    secondaryColor: inset,
    secondaryTextColor: fg,
    secondaryBorderColor: border,
    tertiaryColor: bg,
    tertiaryTextColor: fg,
    tertiaryBorderColor: border,
    edgeLabelBackground: bg,
    clusterBkg: subtle,
    clusterBorder: border,
    // Sequence diagrams.
    actorBkg: subtle,
    actorBorder: accent,
    actorTextColor: fg,
    actorLineColor: border,
    signalColor: muted,
    signalTextColor: fg,
    labelBoxBkgColor: subtle,
    labelBoxBorderColor: border,
    labelTextColor: fg,
    noteBkgColor: inset,
    noteTextColor: fg,
    noteBorderColor: border,
    activationBkgColor: inset,
    activationBorderColor: accent,
    // Pie charts.
    ...Object.fromEntries(palette.map((c, i) => [`pie${i + 1}`, c])),
    pieStrokeColor: bg,
    pieOuterStrokeColor: border,
    pieTitleTextColor: fg,
    pieSectionTextColor: theme === "dark" ? bg : "#ffffff",
    pieLegendTextColor: fg,
    // Bar and line charts.
    xyChart: {
      backgroundColor: bg,
      titleColor: fg,
      xAxisLabelColor: muted,
      xAxisTitleColor: muted,
      xAxisTickColor: border,
      xAxisLineColor: border,
      yAxisLabelColor: muted,
      yAxisTitleColor: muted,
      yAxisTickColor: border,
      yAxisLineColor: border,
      plotColorPalette: palette.join(", "),
    },
  };
}

function draw(source: string, theme: Theme): Promise<string> {
  const key = theme + "\u0000" + source;
  let svg = cache.get(key);
  if (!svg) {
    svg = queue.then(async () => {
      const m = await load();
      if (configured !== theme) {
        m.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "base",
          // Flat shapes, without the drop shadows of the newer look.
          look: "classic",
          themeVariables: themeVariables(theme),
          fontFamily: getComputedStyle(document.body).fontFamily,
          // Natural size instead of shrinking to the column: text stays
          // readable, wide diagrams scroll or open in the expanded view.
          ...Object.fromEntries(NATURAL_SIZE.map((k) => [k, { useMaxWidth: false }])),
          // Tighter than Mermaid's defaults, so diagrams fit the column more
          // often: boxes as wide as their text (Mermaid pads short labels to a
          // uniform width), and labels wrap later.
          flowchart: {
            useMaxWidth: false,
            minNodeWidth: 0,
            wrappingWidth: 220,
            nodeSpacing: 28,
            rankSpacing: 36,
            padding: 10,
            diagramPadding: 4,
          },
          state: { useMaxWidth: false, minNodeWidth: 0 },
          xyChart: { width: 640, height: 300, useMaxWidth: false },
          pie: { textPosition: 0.7, useMaxWidth: false },
        });
        configured = theme;
      }
      const { svg } = await m.render(`suisai-diagram-${nextId++}`, source);
      return svg;
    });
    queue = svg.catch(() => {});
    // Do not keep failures: the next attempt (e.g. after a theme change) tries again.
    svg.catch(() => cache.delete(key));
    cache.set(key, svg);
  }
  return svg;
}

function hydrate(node: HTMLElement, theme: Theme) {
  for (const el of node.querySelectorAll<HTMLElement>(".diagram[data-diagram]")) {
    const source = el.dataset.diagram!;
    if (el.dataset.drawn === theme) continue;
    el.dataset.drawn = theme;
    draw(source, theme).then(
      (svg) => {
        // The element may have been reused for other content meanwhile.
        if (el.dataset.diagram !== source || el.dataset.drawn !== theme) return;
        el.classList.remove("failed");
        el.innerHTML = svg;
        const expand = document.createElement("button");
        expand.className = "diagram-expand";
        expand.title = "Expand";
        expand.setAttribute("aria-label", "Expand diagram");
        expand.innerHTML = EXPAND_ICON;
        expand.addEventListener("click", () => openExpanded(el));
        el.append(expand);
      },
      (e) => {
        if (el.dataset.diagram !== source) return;
        el.classList.add("failed");
        el.title = `This diagram could not be drawn: ${e instanceof Error ? e.message : String(e)}`;
      },
    );
  }
}

const EXPAND_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/></svg>';

/** Shows a drawn diagram scaled up to fill the window. Click or Escape closes it. */
function openExpanded(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (!svg) return;
  const box = svg.viewBox.baseVal;
  const w = box?.width || svg.getBoundingClientRect().width;
  const h = box?.height || svg.getBoundingClientRect().height;

  const overlay = document.createElement("div");
  overlay.className = "diagram-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Diagram");
  const frame = document.createElement("div");
  frame.className = "diagram-overlay-frame";
  const copy = svg.cloneNode(true) as SVGSVGElement;
  // Mermaid ties its styles to the element id: keep it unique but styled alike.
  copy.removeAttribute("style");
  const fit = () => {
    // Fill the window, but never smaller than drawn inline: larger ones scroll.
    const scale = Math.max(1, Math.min((window.innerWidth * 0.92) / w, (window.innerHeight * 0.86) / h, 3));
    copy.setAttribute("width", String(Math.round(w * scale)));
    copy.setAttribute("height", String(Math.round(h * scale)));
  };
  fit();
  frame.append(copy);
  overlay.append(frame);

  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onkey, true);
    window.removeEventListener("resize", fit);
  };
  const onkey = (e: KeyboardEvent) => {
    // Swallow keys so the app's shortcuts do not act behind the overlay.
    e.stopPropagation();
    e.preventDefault();
    if (e.key === "Escape" || e.key === " " || e.key === "Enter") close();
  };
  overlay.addEventListener("click", close);
  window.addEventListener("keydown", onkey, true);
  window.addEventListener("resize", fit);
  document.body.append(overlay);
}

/**
 * Svelte action: draws the diagrams inside an element whose HTML comes from
 * renderMarkdown. Pass the HTML (so it redraws when it changes) and the theme.
 */
export function diagrams(node: HTMLElement, params: { html: string; theme: Theme }) {
  hydrate(node, params.theme);
  return {
    update(next: { html: string; theme: Theme }) {
      // After the new HTML is in place.
      queueMicrotask(() => hydrate(node, next.theme));
    },
  };
}
