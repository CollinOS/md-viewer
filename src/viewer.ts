// Turning rendered HTML into DOM: strip unsafe tags, point local images at
// the mdfile:// protocol, and patch existing documents with morphdom so
// updates don't flicker or lose scroll position.

import morphdom from "morphdom";
import { convertFileSrc } from "@tauri-apps/api/core";

/** Tags that could restyle or take over the app, which GitHub also strips. */
const STRIP =
  "script,style,iframe,frame,frameset,object,embed,meta,base,link,form,title,noscript,applet,template,portal";

const MEDIA = "img[src],video[src],video[poster],audio[src],source[src],track[src],input[type=image][src]";

/** Above this many characters, off-screen blocks skip layout and paint. */
const LARGE_DOC = 200_000;

// "http://mdfile.localhost/" on Windows, "mdfile://localhost/" elsewhere.
const PROTOCOL_BASE = convertFileSrc("", "mdfile");

/** Rewrites a local image path to the mdfile protocol. Remote URLs are kept. */
export function mediaUrl(docId: number, raw: string): string {
  const src = raw.trim();
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  if (src.startsWith("//")) return "https:" + src;
  let path = src;
  if (/^file:/i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname).replace(/^\/([a-zA-Z]:)/, "$1");
    } catch {
      return "";
    }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(path)) {
    return ""; // unknown scheme
  } else {
    path = path.split(/[?#]/)[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep as written */
    }
  }
  return `${PROTOCOL_BASE}${docId}/${encodeURIComponent(path)}`;
}

function prepare(html: string, docId: number): DocumentFragment {
  // Template content is inert: nothing loads until the nodes are adopted
  // into the page, so images only ever request their rewritten URLs.
  const t = document.createElement("template");
  t.innerHTML = html;
  const frag = t.content;
  for (const n of frag.querySelectorAll(STRIP)) n.remove();
  for (const n of frag.querySelectorAll<HTMLElement>(MEDIA)) {
    for (const attr of ["src", "poster"]) {
      const v = n.getAttribute(attr);
      if (v !== null) n.setAttribute(attr, mediaUrl(docId, v));
    }
    n.removeAttribute("srcset");
  }
  return frag;
}

export function createArticle(): HTMLElement {
  const a = document.createElement("article");
  a.className = "markdown-body";
  return a;
}

/** Fills or updates a document. `morph` keeps unchanged nodes in place. */
export function setContent(article: HTMLElement, html: string, docId: number, morph: boolean) {
  const frag = prepare(html, docId);
  article.classList.toggle("large", html.length > LARGE_DOC);
  if (!morph || !article.firstChild) {
    article.replaceChildren(frag);
    return;
  }
  const next = article.cloneNode(false) as HTMLElement;
  next.append(frag);
  morphdom(article, next, {
    childrenOnly: true,
    // morphdom removes any element with an id that's missing from the new
    // HTML, even inside a subtree we told it to skip. Rendered diagrams carry
    // generated ids, so they must not count as keys.
    getNodeKey(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
      const el = node as Element;
      if (!el.id || el.closest("pre.mermaid")) return undefined;
      return el.id;
    },
    onBeforeElUpdated(from, to) {
      // A rendered diagram whose source hasn't changed: keep the SVG.
      if (from.classList.contains("mermaid") && from.getAttribute("data-hash") === to.getAttribute("data-hash")) {
        const pos = to.getAttribute("data-sourcepos");
        if (pos !== null) from.setAttribute("data-sourcepos", pos);
        return false;
      }
      return !from.isEqualNode(to);
    },
  });
}

export function scrollToAnchor(article: HTMLElement, id: string): boolean {
  const esc = CSS.escape(id);
  const target = article.querySelector(`[id="${esc}"]`) ?? article.querySelector(`[name="${esc}"]`);
  target?.scrollIntoView({ block: "start" });
  return !!target;
}

/** The source line where a block starts, from comrak's data-sourcepos. */
function startLine(el: Element): number {
  const pos = el.getAttribute("data-sourcepos");
  return pos ? parseInt(pos, 10) : NaN;
}

/** Scrolls the preview so the block containing `line` is at the top. */
export function scrollToLine(pane: HTMLElement, article: HTMLElement, line: number) {
  const blocks = article.children;
  let lo = 0;
  let hi = blocks.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = startLine(blocks[mid]);
    if (Number.isNaN(l) || l <= line) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) {
    pane.scrollTop = 0;
    return;
  }
  const el = blocks[best] as HTMLElement;
  const next = blocks[best + 1] as HTMLElement | undefined;
  const from = startLine(el);
  const to = next ? startLine(next) : NaN;
  let top = el.offsetTop;
  if (next && !Number.isNaN(from) && !Number.isNaN(to) && to > from) {
    top += ((line - from) / (to - from)) * (next.offsetTop - el.offsetTop);
  }
  pane.scrollTop = Math.max(0, top - 24);
}
