import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, mark, type OpenOutcome, type OpenedDoc } from "./api";
import { applySettings, isDark, onSettingsApplied, settings, toggleSettings, updateSettings } from "./settings";
import { ask, el, icons, toast } from "./ui";
import { createArticle, scrollToAnchor, scrollToLine, setContent } from "./viewer";
import type { Editor, EditorState, Text } from "./editor";

mark("frontend: script start");
applySettings(window.__MDV_BOOT__!.settings);

const appWindow = getCurrentWindow();
const tabsEl = document.querySelector<HTMLElement>(".tabs")!;
const editorPane = document.querySelector<HTMLElement>(".editor-pane")!;
const divider = document.querySelector<HTMLElement>(".divider")!;
const previewPane = document.querySelector<HTMLElement>(".preview-pane")!;
const docHost = document.querySelector<HTMLElement>(".doc-host")!;
const emptyState = document.querySelector<HTMLElement>(".empty-state")!;
const editButton = document.querySelector<HTMLButtonElement>('[data-action="edit"]')!;

interface Tab {
  id: number;
  path: string;
  name: string;
  article: HTMLElement;
  button: HTMLElement;
  scrollTop: number;
  editing: boolean;
  /** Editor state while the tab isn't in the editor view. */
  editorState?: EditorState;
  /** The document as last loaded or saved, to tell whether there are edits. */
  savedDoc?: Text;
  dirty: boolean;
  /** HTML from disk that arrived while there were unsaved edits. */
  diskHtml?: string;
  missing: boolean;
  banner?: HTMLElement;
}

const tabs: Tab[] = [];
let active: Tab | null = null;
const closedPaths: string[] = [];

// ---------- Lazy modules ----------

let editor: Editor | null = null;
let editorModule: Promise<typeof import("./editor")> | null = null;
let mermaidModule: Promise<typeof import("./mermaid")> | null = null;

function loadEditor() {
  editorModule ??= import("./editor");
  return editorModule;
}

async function getEditor(): Promise<Editor> {
  const mod = await loadEditor();
  editor ??= new mod.Editor(editorPane, {
    onChange: () => {
      if (active?.editing) scheduleRender(active);
    },
    onScroll: (line) => {
      if (active?.editing) scrollToLine(previewPane, active.article, line);
    },
  });
  return editor;
}

function renderDiagrams(tab: Tab) {
  if (!tab.article.querySelector("pre.mermaid:not([data-processed])")) return;
  mermaidModule ??= import("./mermaid");
  void mermaidModule.then((m) => m.renderDiagrams(tab.article, isDark()));
}

onSettingsApplied((_s, dark) => {
  if (mermaidModule) void mermaidModule.then((m) => m.rethemeDiagrams(tabs.map((t) => t.article), dark));
});

// ---------- Tabs ----------

function editorStateOf(tab: Tab): EditorState | undefined {
  return tab === active && tab.editing && editor ? editor.view.state : tab.editorState;
}

function updateTitle() {
  const name = active ? `${active.dirty ? "● " : ""}${active.name} - MD Viewer` : "MD Viewer";
  document.title = name;
  void appWindow.setTitle(name);
}

function updateTabButton(tab: Tab) {
  tab.button.classList.toggle("dirty", tab.dirty);
  tab.button.classList.toggle("missing", tab.missing);
  tab.button.classList.toggle("active", tab === active);
  tab.button.setAttribute("aria-selected", String(tab === active));
}

function layout() {
  const editing = !!active?.editing;
  editorPane.hidden = !editing;
  divider.hidden = !editing;
  editButton.disabled = !active;
  editButton.setAttribute("aria-pressed", String(editing));
  emptyState.hidden = tabs.length > 0;
}

function createTabButton(tab: Tab): HTMLElement {
  const close = el("button", { className: "tab-close", title: "Close (Ctrl+W)", tabIndex: -1 });
  close.innerHTML = icons.close;
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTab(tab);
  });
  const b = el("div", { className: "tab", title: tab.path }, el("span", { className: "tab-name", textContent: tab.name }), close);
  b.setAttribute("role", "tab");
  enableTabDragging(b, tab);
  return b;
}

function addTab(doc: OpenedDoc): Tab {
  const tab: Tab = {
    id: doc.id,
    path: doc.path,
    name: doc.name,
    article: createArticle(),
    button: null!,
    scrollTop: 0,
    editing: false,
    dirty: false,
    missing: false,
  };
  tab.button = createTabButton(tab);
  setContent(tab.article, doc.html, tab.id, false);
  tabs.push(tab);
  tabsEl.append(tab.button);
  return tab;
}

function activate(tab: Tab) {
  if (active === tab) return;
  const prev = active;
  if (prev) {
    prev.scrollTop = previewPane.scrollTop;
    if (prev.editing && editor) prev.editorState = editor.view.state;
  }
  active = tab;
  docHost.replaceChildren(...(tab.banner ? [tab.banner] : []), tab.article);
  previewPane.scrollTop = tab.scrollTop;
  if (tab.editing && editor && tab.editorState) {
    editor.view.setState(tab.editorState);
  }
  if (prev) updateTabButton(prev);
  updateTabButton(tab);
  tab.button.scrollIntoView({ block: "nearest", inline: "nearest" });
  layout();
  updateTitle();
  renderDiagrams(tab);
}

function activateById(id: number) {
  const tab = tabs.find((t) => t.id === id);
  if (tab) activate(tab);
}

async function closeTab(tab: Tab): Promise<boolean> {
  if (tab.dirty) {
    if (active !== tab) activate(tab);
    const choice = await ask(
      `Save changes to ${tab.name}?`,
      "Your changes will be lost if you don't save them.",
      [
        { label: "Save", value: "save", primary: true },
        { label: "Don't save", value: "discard" },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (choice === "cancel") return false;
    if (choice === "save" && !(await save(tab))) return false;
  }
  const i = tabs.indexOf(tab);
  if (i < 0) return true;
  tabs.splice(i, 1);
  tab.button.remove();
  closedPaths.push(tab.path);
  void api.closeDoc(tab.id);
  if (active === tab) {
    active = null;
    docHost.replaceChildren();
    const next = tabs[i] ?? tabs[i - 1];
    if (next) activate(next);
  }
  if (tabs.length === 0) {
    // close() rather than destroy() so Rust still saves the window position.
    await appWindow.close();
    return true;
  }
  layout();
  updateTitle();
  return true;
}

function cycle(delta: number) {
  if (!active || tabs.length < 2) return;
  const i = tabs.indexOf(active);
  activate(tabs[(i + delta + tabs.length) % tabs.length]);
}

/** Pointer-based reordering (HTML drag and drop is taken over by file drops). */
function enableTabDragging(button: HTMLElement, tab: Tab) {
  button.addEventListener("pointerdown", (e) => {
    if (e.button === 1) {
      e.preventDefault(); // no autoscroll on middle click
      return;
    }
    if (e.button !== 0 || (e.target as Element).closest(".tab-close")) return;
    activate(tab);
    const startX = e.clientX;
    let dragging = false;
    let target: { tab: Tab; after: boolean } | null = null;
    button.setPointerCapture(e.pointerId);

    const clearMarks = () => tabs.forEach((t) => t.button.classList.remove("drop-before", "drop-after"));
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 5) return;
      dragging = true;
      button.classList.add("dragging");
      clearMarks();
      target = null;
      for (const t of tabs) {
        const r = t.button.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX < r.right && t !== tab) {
          target = { tab: t, after: ev.clientX > r.left + r.width / 2 };
          t.button.classList.add(target.after ? "drop-after" : "drop-before");
        }
      }
    };
    const up = () => {
      button.removeEventListener("pointermove", move);
      button.removeEventListener("pointerup", up);
      button.removeEventListener("pointercancel", up);
      button.classList.remove("dragging");
      clearMarks();
      if (!dragging || !target) return;
      tabs.splice(tabs.indexOf(tab), 1);
      const j = tabs.indexOf(target.tab) + (target.after ? 1 : 0);
      tabs.splice(j, 0, tab);
      tabsEl.replaceChildren(...tabs.map((t) => t.button));
    };
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerup", up);
    button.addEventListener("pointercancel", up);
  });
  button.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      void closeTab(tab);
    }
  });
}

// ---------- Opening ----------

function handleOutcome(o: OpenOutcome, focus: boolean): Tab | null {
  switch (o.kind) {
    case "opened": {
      const tab = addTab(o);
      if (focus || !active) activate(tab);
      else updateTabButton(tab);
      return tab;
    }
    case "existing": {
      const tab = tabs.find((t) => t.id === o.id) ?? null;
      if (tab && focus) activate(tab);
      return tab;
    }
    case "failed":
      toast(`Couldn't open ${o.path}: ${o.message}`, "error", 6000);
      return null;
    case "elsewhere":
      return null;
  }
}

async function openPaths(paths: string[]): Promise<Tab | null> {
  const outcomes = await Promise.all(paths.map((p) => api.openDoc(p)));
  let last: Tab | null = null;
  outcomes.forEach((o, i) => {
    const t = handleOutcome(o, i === outcomes.length - 1);
    if (t) last = t;
  });
  layout();
  return last;
}

async function openDialog() {
  const paths = await api.pickFiles();
  if (paths.length) await openPaths(paths);
}

// ---------- Editing ----------

let renderTimer: number | undefined;
let rendering = false;
let renderAgain = false;
let lastRenderCost = 4;

/** Re-renders the preview after edits. The delay adapts to how long renders
 *  take, so small files update almost instantly and big ones don't lag typing. */
function scheduleRender(tab: Tab) {
  clearTimeout(renderTimer);
  const delay = Math.min(300, Math.max(10, lastRenderCost * 1.5));
  renderTimer = window.setTimeout(() => void runRender(tab), delay);
}

async function runRender(tab: Tab) {
  if (rendering) {
    renderAgain = true;
    return;
  }
  const state = editorStateOf(tab);
  if (!state) return;
  rendering = true;
  const started = performance.now();
  try {
    const html = await api.render(state.doc.toString(), true);
    setContent(tab.article, html, tab.id, true);
    renderDiagrams(tab);
  } finally {
    rendering = false;
    lastRenderCost = performance.now() - started;
  }
  updateDirty(tab);
  if (renderAgain) {
    renderAgain = false;
    if (active?.editing) void runRender(active);
  }
}

function updateDirty(tab: Tab) {
  const state = editorStateOf(tab);
  const dirty = !!state && !!tab.savedDoc && !state.doc.eq(tab.savedDoc);
  if (dirty === tab.dirty) return;
  tab.dirty = dirty;
  updateTabButton(tab);
  if (tab === active) updateTitle();
}

async function toggleEdit(tab: Tab | null = active) {
  if (!tab) return;
  if (tab.editing) {
    if (editor) tab.editorState = editor.view.state;
    tab.editing = false;
    layout();
    previewPane.focus();
    return;
  }
  const ed = await getEditor();
  if (!tab.editorState) {
    const text = await api.getText(tab.id);
    tab.editorState = ed.createState(text);
    tab.savedDoc = tab.editorState.doc;
  }
  tab.editing = true;
  if (tab !== active) return;
  ed.view.setState(tab.editorState);
  layout();
  ed.focus();
  // Re-render with source positions so the preview can follow the editor.
  void runRender(tab);
  mark("editor ready");
}

async function save(tab: Tab | null = active): Promise<boolean> {
  if (!tab) return false;
  const state = editorStateOf(tab);
  // Don't trust tab.dirty here: it only updates after the preview re-renders,
  // and Ctrl+S can arrive right after a keystroke.
  if (!state || !tab.savedDoc || state.doc.eq(tab.savedDoc)) return true;
  try {
    const res = await api.save(tab.id, state.doc.toString());
    tab.savedDoc = state.doc;
    tab.diskHtml = undefined;
    tab.missing = false;
    removeBanner(tab);
    updateDirty(tab);
    updateTabButton(tab);
    if (res.warning) toast(res.warning);
    return true;
  } catch (e) {
    toast(String(e), "error", 8000);
    return false;
  }
}

// ---------- Changes on disk ----------

function showBanner(tab: Tab, message: string, actions: [string, () => void][]) {
  removeBanner(tab);
  const banner = el("div", { className: "banner" }, el("span", { className: "msg", textContent: message }));
  for (const [label, fn] of actions) {
    const b = el("button", { textContent: label });
    b.addEventListener("click", fn);
    banner.append(b);
  }
  tab.banner = banner;
  if (tab === active) docHost.prepend(banner);
}

function removeBanner(tab: Tab) {
  tab.banner?.remove();
  tab.banner = undefined;
}

/** Brings a clean (or overridden) tab up to date with the file on disk. */
async function applyDiskVersion(tab: Tab, html: string) {
  tab.diskHtml = undefined;
  tab.missing = false;
  removeBanner(tab);
  setContent(tab.article, html, tab.id, true);
  renderDiagrams(tab);
  const state = editorStateOf(tab);
  if (state) {
    const text = await api.getText(tab.id);
    const { minimalChange } = await loadEditor();
    const change = minimalChange(state.doc, text);
    if (tab === active && tab.editing && editor) {
      editor.view.dispatch({ changes: change });
      tab.savedDoc = editor.view.state.doc;
    } else {
      tab.editorState = state.update({ changes: change }).state;
      tab.savedDoc = tab.editorState.doc;
    }
    if (tab.editing) void runRender(tab);
  }
  updateDirty(tab);
  updateTabButton(tab);
}

function onDiskChange(id: number, html: string) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (!tab.dirty) {
    void applyDiskVersion(tab, html);
    return;
  }
  tab.diskHtml = html;
  tab.missing = false;
  updateTabButton(tab);
  showBanner(tab, `${tab.name} changed on disk, and you have unsaved edits.`, [
    ["Load theirs", () => void applyDiskVersion(tab, tab.diskHtml ?? html)],
    [
      "Keep mine",
      () => {
        tab.diskHtml = undefined;
        removeBanner(tab);
      },
    ],
  ]);
}

function onDiskMissing(id: number) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.missing) return;
  tab.missing = true;
  updateTabButton(tab);
  showBanner(tab, `${tab.name} was deleted or moved. Saving will create it again.`, [["Dismiss", () => removeBanner(tab)]]);
}

// ---------- Links ----------

docHost.addEventListener("click", async (e) => {
  const a = (e.target as Element).closest("a");
  if (!a || !active) return;
  e.preventDefault();
  const href = a.getAttribute("href");
  if (!href) return;
  if (href.startsWith("#")) {
    scrollToAnchor(active.article, decodeURIComponent(href.slice(1)));
    return;
  }
  const res = await api.openLink(active.id, href);
  if (res.kind === "failed") toast(res.message, "error");
  if (res.kind === "open") {
    const tab = await openPaths([res.path]);
    if (tab && res.fragment) scrollToAnchor(tab.article, decodeURIComponent(res.fragment));
  }
});

// Middle and shift clicks on links would otherwise open a browser window.
docHost.addEventListener("auxclick", (e) => {
  if ((e.target as Element).closest("a")) e.preventDefault();
});

// ---------- Split view divider ----------

divider.addEventListener("pointerdown", (e) => {
  divider.setPointerCapture(e.pointerId);
  divider.classList.add("active");
  const total = editorPane.parentElement!.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    const pct = Math.min(80, Math.max(20, ((ev.clientX - total.left) / total.width) * 100));
    document.documentElement.style.setProperty("--editor-width", `${pct}%`);
  };
  const up = () => {
    divider.classList.remove("active");
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", up);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", up);
});

// ---------- Commands and shortcuts ----------

const actions: Record<string, () => void> = {
  open: () => void openDialog(),
  edit: () => void toggleEdit(),
  settings: () => toggleSettings(),
};

for (const b of document.querySelectorAll<HTMLElement>("[data-action]")) {
  b.addEventListener("click", () => actions[b.dataset.action!]?.());
}

function changeFontSize(delta: number) {
  const size = delta === 0 ? 16 : Math.min(24, Math.max(12, settings().fontSize + delta));
  updateSettings({ fontSize: size });
}

window.addEventListener(
  "keydown",
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (e.key === "F5" || (ctrl && key === "r")) {
      // Reloading the page would throw away tabs and unsaved edits.
    } else if (ctrl && e.key === "Tab") {
      cycle(e.shiftKey ? -1 : 1);
    } else if (ctrl && (e.key === "PageDown" || e.key === "PageUp")) {
      cycle(e.key === "PageDown" ? 1 : -1);
    } else if (ctrl && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (tab) activate(tab);
    } else if (ctrl && e.shiftKey && key === "t") {
      const path = closedPaths.pop();
      if (path) void openPaths([path]);
    } else if (ctrl && e.shiftKey && key === "n") {
      void api.newWindow();
    } else if (ctrl && !e.shiftKey && key === "o") {
      void openDialog();
    } else if (ctrl && !e.shiftKey && key === "s") {
      void save();
    } else if (ctrl && !e.shiftKey && key === "e") {
      void toggleEdit();
    } else if (ctrl && !e.shiftKey && key === "w") {
      if (active) void closeTab(active);
    } else if (ctrl && e.key === ",") {
      toggleSettings();
    } else if (ctrl && (e.key === "=" || e.key === "+")) {
      changeFontSize(1);
    } else if (ctrl && e.key === "-") {
      changeFontSize(-1);
    } else if (ctrl && e.key === "0") {
      changeFontSize(0);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  { capture: true },
);

// Only show the context menu where it's useful (copying a selection, editing).
window.addEventListener("contextmenu", (e) => {
  const target = e.target as Element;
  const selection = window.getSelection()?.toString() ?? "";
  if (!selection && !target.closest(".cm-editor, input, textarea")) e.preventDefault();
});

// ---------- Window events ----------

const dropOverlay = el("div", { className: "drop-overlay", textContent: "Drop to open" });
dropOverlay.hidden = true;
document.body.append(dropOverlay);

void getCurrentWebview().onDragDropEvent((e) => {
  const p = e.payload;
  if (p.type === "enter" || p.type === "over") dropOverlay.hidden = false;
  else dropOverlay.hidden = true;
  if (p.type === "drop" && p.paths.length) void openPaths(p.paths);
});

void appWindow.listen<string[]>("open-paths", (e) => void openPaths(e.payload));
void appWindow.listen<number>("activate-doc", (e) => activateById(e.payload));
void appWindow.listen<{ id: number; html: string }>("doc-changed", (e) => onDiskChange(e.payload.id, e.payload.html));
void appWindow.listen<number>("doc-missing", (e) => onDiskMissing(e.payload));
void appWindow.listen<ReturnType<typeof settings>>("settings-changed", (e) => applySettings(e.payload));

void appWindow.onCloseRequested(async (e) => {
  const dirty = tabs.filter((t) => t.dirty);
  if (!dirty.length) return;
  const names = dirty.map((t) => t.name).join(", ");
  const choice = await ask(
    dirty.length === 1 ? `Save changes to ${names}?` : `Save changes to ${dirty.length} files?`,
    dirty.length === 1 ? "Your changes will be lost if you don't save them." : `Unsaved: ${names}`,
    [
      { label: dirty.length === 1 ? "Save" : "Save all", value: "save", primary: true },
      { label: "Don't save", value: "discard" },
      { label: "Cancel", value: "cancel" },
    ],
    "cancel",
  );
  if (choice === "cancel") {
    e.preventDefault();
    return;
  }
  if (choice === "save") {
    for (const t of dirty) {
      if (!(await save(t))) {
        e.preventDefault();
        return;
      }
    }
  }
});

// ---------- Startup ----------

async function start() {
  const outcomes = await api.boot();
  mark("frontend: boot returned");
  let first: Tab | null = null;
  for (const o of outcomes) {
    const t = handleOutcome(o, false);
    first ??= t;
  }
  if (first) activate(first);
  layout();
  mark("frontend: content inserted");
  await api.windowReady();
  testHooks.ready = true;
  requestAnimationFrame(() => mark("frontend: first frame"));
  // Warm the editor module in the background once the window is up, so the
  // first Ctrl+E is quick without slowing down startup.
  setTimeout(() => void loadEditor(), 1500);
}

// Exposed for the end-to-end tests.
declare global {
  interface Window {
    __mdv?: unknown;
  }
}
const testHooks = {
  ready: false,
  tabs: () => tabs.map((t) => ({ id: t.id, name: t.name, path: t.path, dirty: t.dirty, editing: t.editing, missing: t.missing, active: t === active })),
  editorText: () => (active ? editorStateOf(active)?.doc.toString() : undefined),
};
window.__mdv = testHooks;

void start();
