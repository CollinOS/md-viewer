// Applying settings to the page, and the settings dialog.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type Settings } from "./api";
import { el } from "./ui";

export interface ThemeInfo {
  id: string;
  name: string;
  dark: boolean;
  /** bg, fg, accent, keyword, string: used for the preview swatch */
  swatch: [string, string, string, string, string];
}

export const THEMES: ThemeInfo[] = [
  { id: "github-light", name: "GitHub Light", dark: false, swatch: ["#ffffff", "#1f2328", "#0969da", "#cf222e", "#0a3069"] },
  { id: "solarized-light", name: "Solarized Light", dark: false, swatch: ["#fdf6e3", "#586e75", "#268bd2", "#859900", "#2aa198"] },
  { id: "sepia", name: "Sepia", dark: false, swatch: ["#f8f1e3", "#433422", "#a0522d", "#a0391c", "#5b7a1f"] },
  { id: "github-dark", name: "GitHub Dark", dark: true, swatch: ["#0d1117", "#f0f6fc", "#4493f8", "#ff7b72", "#a5d6ff"] },
  { id: "solarized-dark", name: "Solarized Dark", dark: true, swatch: ["#002b36", "#93a1a1", "#2aa1e6", "#859900", "#2aa198"] },
  { id: "nord", name: "Nord", dark: true, swatch: ["#2e3440", "#d8dee9", "#88c0d0", "#81a1c1", "#a3be8c"] },
  { id: "dracula", name: "Dracula", dark: true, swatch: ["#282a36", "#f8f8f2", "#8be9fd", "#ff79c6", "#f1fa8c"] },
  { id: "gruvbox-dark", name: "Gruvbox Dark", dark: true, swatch: ["#282828", "#ebdbb2", "#83a598", "#fb4934", "#b8bb26"] },
];

const BODY_FONTS: Record<Settings["bodyFont"], string> = {
  sans: '-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  serif: 'Charter, "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif',
  mono: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
};

const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");

let current: Settings = window.__MDV_BOOT__!.settings;
const listeners: ((s: Settings, dark: boolean) => void)[] = [];

export function settings(): Settings {
  return current;
}

export function isDark(s: Settings = current): boolean {
  if (s.mode === "light") return false;
  if (s.mode === "dark") return true;
  return systemDarkQuery.matches;
}

export function onSettingsApplied(fn: (s: Settings, dark: boolean) => void) {
  listeners.push(fn);
}

let lastWindowTheme: string | null = null;

export function applySettings(s: Settings) {
  current = s;
  const dark = isDark(s);
  const root = document.documentElement;
  const theme = THEMES.find((t) => t.id === (dark ? s.darkTheme : s.lightTheme));
  root.dataset.theme = theme?.id ?? (dark ? "github-dark" : "github-light");
  const set = (name: string, value: string | null) =>
    value ? root.style.setProperty(name, value) : root.style.removeProperty(name);
  set("--accent", s.accent || null);
  set("--font-size", `${s.fontSize}px`);
  set("--content-width", s.contentWidth > 0 ? `${s.contentWidth}px` : "none");
  set("--body-font", BODY_FONTS[s.bodyFont] ?? null);
  set("--code-font", s.codeFont.trim() ? `${s.codeFont}, ui-monospace, monospace` : null);

  // Match the native title bar to the theme.
  const windowTheme = dark ? "dark" : "light";
  if (windowTheme !== lastWindowTheme) {
    lastWindowTheme = windowTheme;
    void getCurrentWindow().setTheme(windowTheme).catch(() => {});
  }
  for (const fn of listeners) fn(s, dark);
}

systemDarkQuery.addEventListener("change", () => applySettings(current));

let saveTimer: number | undefined;

/** Applies locally right away and saves (and syncs other windows) shortly after. */
export function updateSettings(patch: Partial<Settings>) {
  applySettings({ ...current, ...patch });
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void api.saveSettings(current), 250);
}

// ---------- Settings dialog ----------

let dialog: HTMLDialogElement | null = null;

function segmented<T extends string>(options: [T, string][], value: () => T, onPick: (v: T) => void) {
  const wrap = el("div", { className: "segmented" });
  const buttons = options.map(([v, label]) => {
    const b = el("button", { textContent: label });
    b.addEventListener("click", () => {
      onPick(v);
      sync();
    });
    wrap.append(b);
    return [v, b] as const;
  });
  const sync = () => buttons.forEach(([v, b]) => b.setAttribute("aria-pressed", String(v === value())));
  sync();
  return { node: wrap, sync };
}

function themeGrid(slot: "lightTheme" | "darkTheme") {
  const grid = el("div", { className: "theme-grid" });
  const cards = THEMES.map((t) => {
    const [bg, fg, accent, kw, str] = t.swatch;
    const preview = el("div", { className: "preview" });
    preview.style.background = bg;
    for (const [color, width] of [[fg, "70%"], [kw, "45%"], [str, "85%"], [accent, "35%"]] as const) {
      const bar = el("i");
      bar.style.background = color;
      bar.style.width = width;
      preview.append(bar);
    }
    const card = el("button", { className: "theme-card", title: t.name }, preview, el("span", { textContent: t.name }));
    card.addEventListener("click", () => {
      updateSettings({ [slot]: t.id });
      sync();
    });
    grid.append(card);
    return [t.id, card] as const;
  });
  const sync = () => cards.forEach(([id, c]) => c.setAttribute("aria-pressed", String(id === current[slot])));
  sync();
  return grid;
}

function range(min: number, max: number, step: number, get: () => number, set: (v: number) => void, format: (v: number) => string) {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  input.valueAsNumber = get();
  const label = el("span", { className: "value", textContent: format(get()) });
  input.addEventListener("input", () => {
    set(input.valueAsNumber);
    label.textContent = format(input.valueAsNumber);
  });
  return { node: el("div", { className: "inline" }, input, label), input, label };
}

function row(label: string, control: Node, hint?: string) {
  const left = el("div", {}, el("label", { textContent: label }));
  if (hint) left.append(el("div", { className: "hint", textContent: hint }));
  return el("div", { className: "row" }, left, control);
}

function build(): HTMLDialogElement {
  const d = el("dialog", { className: "settings" });
  const close = el("button", { className: "icon-btn", title: "Close (Esc)", ariaLabel: "Close" });
  close.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  close.addEventListener("click", () => d.close());

  const mode = segmented<Settings["mode"]>(
    [["system", "System"], ["light", "Light"], ["dark", "Dark"]],
    () => current.mode,
    (v) => updateSettings({ mode: v }),
  );

  // Accent color
  const accentInput = el("input", { type: "color" });
  const accentReset = el("button", { className: "link-btn", textContent: "Use theme color" });
  const syncAccent = () => {
    accentInput.value = current.accent || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().slice(0, 7);
    accentReset.disabled = !current.accent;
  };
  accentInput.addEventListener("input", () => {
    updateSettings({ accent: accentInput.value });
    accentReset.disabled = false;
  });
  accentReset.addEventListener("click", () => {
    updateSettings({ accent: "" });
    syncAccent();
  });
  onSettingsApplied(() => {
    if (!current.accent) syncAccent();
  });
  syncAccent();

  const fontSize = range(12, 24, 1, () => current.fontSize, (v) => updateSettings({ fontSize: v }), (v) => `${v}px`);
  const width = range(560, 1600, 20, () => current.contentWidth || 1600, (v) => updateSettings({ contentWidth: v >= 1600 ? 0 : v }), (v) =>
    v >= 1600 ? "Full" : `${v}px`,
  );

  const bodyFont = segmented<Settings["bodyFont"]>(
    [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]],
    () => current.bodyFont,
    (v) => updateSettings({ bodyFont: v }),
  );

  const codeFont = el("input", { type: "text", placeholder: "Cascadia Code, Consolas", value: current.codeFont });
  codeFont.addEventListener("input", () => updateSettings({ codeFont: codeFont.value }));

  const openIn = segmented<Settings["openIn"]>(
    [["tab", "New tab"], ["window", "New window"]],
    () => current.openIn,
    (v) => updateSettings({ openIn: v }),
  );

  const content = el(
    "div",
    { className: "content" },
    el("section", {}, el("h3", { textContent: "Appearance" }), row("Mode", mode.node, "System follows your Windows setting")),
    el("section", {}, el("h3", { textContent: "Light theme" }), themeGrid("lightTheme")),
    el("section", {}, el("h3", { textContent: "Dark theme" }), themeGrid("darkTheme")),
    el(
      "section",
      {},
      el("h3", { textContent: "Text" }),
      row("Accent color", el("div", { className: "inline" }, accentReset, accentInput)),
      row("Font size", fontSize.node, "Ctrl+Plus and Ctrl+Minus also work"),
      row("Content width", width.node),
      row("Body font", bodyFont.node),
      row("Code font", codeFont, "Leave empty for the default"),
    ),
    el("section", {}, el("h3", { textContent: "Files" }), row("Open files from Explorer in", openIn.node)),
  );

  d.append(el("header", {}, el("h2", { textContent: "Settings" }), close), content);
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close(); // click on the backdrop
  });
  // Keep controls in sync when settings change elsewhere (shortcuts, other windows).
  onSettingsApplied(() => {
    if (!d.open) return;
    mode.sync();
    bodyFont.sync();
    openIn.sync();
    fontSize.input.valueAsNumber = current.fontSize;
    fontSize.label.textContent = `${current.fontSize}px`;
  });
  document.body.append(d);
  return d;
}

export function toggleSettings() {
  dialog ??= build();
  if (dialog.open) dialog.close();
  else dialog.showModal();
}
