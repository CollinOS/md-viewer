// Mermaid diagrams. The library is large, so it's only imported the first
// time a document actually contains a diagram. Diagram colors come from the
// active theme's CSS variables so they match the rest of the document.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
/** Theme id + font the library was last initialized with. */
let initializedFor: string | null = null;

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

const PENDING = "pre.mermaid:not([data-processed])";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeKey(): string {
  return `${document.documentElement.dataset.theme}|${cssVar("--accent")}|${cssVar("--body-font")}`;
}

function configure(mermaid: Mermaid, dark: boolean) {
  const key = themeKey();
  if (key === initializedFor) return;
  initializedFor = key;
  const bg = cssVar("--bg");
  const subtle = cssVar("--bg-subtle");
  const fg = cssVar("--fg");
  const muted = cssVar("--fg-muted");
  const border = cssVar("--border");
  const accent = cssVar("--accent");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: cssVar("--body-font"),
    themeVariables: {
      darkMode: dark,
      background: bg,
      fontSize: "15px",
      primaryColor: subtle,
      primaryTextColor: fg,
      primaryBorderColor: accent,
      secondaryColor: bg,
      secondaryTextColor: fg,
      secondaryBorderColor: border,
      tertiaryColor: subtle,
      tertiaryTextColor: fg,
      tertiaryBorderColor: border,
      lineColor: muted,
      textColor: fg,
      mainBkg: subtle,
      nodeBorder: accent,
      clusterBkg: bg,
      clusterBorder: border,
      edgeLabelBackground: bg,
      titleColor: fg,
      noteBkgColor: subtle,
      noteTextColor: fg,
      noteBorderColor: border,
      actorBkg: subtle,
      actorBorder: accent,
      actorTextColor: fg,
      signalColor: fg,
      signalTextColor: fg,
    },
  });
}

export async function renderDiagrams(root: ParentNode, dark: boolean) {
  const nodes = [...root.querySelectorAll<HTMLElement>(PENDING)];
  if (!nodes.length) return;
  const mermaid = await load();
  configure(mermaid, dark);
  // The node may have been replaced by a newer render while we waited.
  const live = nodes.filter((n) => n.isConnected && !n.hasAttribute("data-processed"));
  for (const n of live) n.dataset.src = n.textContent ?? "";
  try {
    await mermaid.run({ nodes: live });
  } catch {
    for (const n of live) {
      if (!n.querySelector("svg")) n.classList.add("mermaid-error");
    }
  }
}

/** Redraws already rendered diagrams after the theme changes. */
export async function rethemeDiagrams(roots: ParentNode[], dark: boolean) {
  if (!loading || initializedFor === null || initializedFor === themeKey()) return;
  for (const root of roots) {
    for (const n of root.querySelectorAll<HTMLElement>("pre.mermaid[data-processed]")) {
      if (n.dataset.src === undefined) continue;
      n.textContent = n.dataset.src;
      n.removeAttribute("data-processed");
    }
  }
  for (const root of roots) {
    if ((root as Element).isConnected) await renderDiagrams(root, dark);
  }
}
