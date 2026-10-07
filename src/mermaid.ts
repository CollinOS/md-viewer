// Mermaid diagrams. The library is large, so it's only imported the first
// time a document actually contains a diagram.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
let themed: boolean | null = null;

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

const PENDING = "pre.mermaid:not([data-processed])";

export async function renderDiagrams(root: ParentNode, dark: boolean) {
  const nodes = [...root.querySelectorAll<HTMLElement>(PENDING)];
  if (!nodes.length) return;
  const mermaid = await load();
  if (themed !== dark) {
    themed = dark;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "inherit",
    });
  }
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

/** Re-renders already drawn diagrams, e.g. after switching light and dark. */
export async function rethemeDiagrams(roots: ParentNode[], dark: boolean) {
  if (!loading || themed === dark) return;
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

export function hasPendingDiagrams(root: ParentNode): boolean {
  return root.querySelector(PENDING) !== null;
}
