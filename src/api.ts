// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";

export interface WindowGeometry {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Settings {
  mode: "system" | "light" | "dark";
  lightTheme: string;
  darkTheme: string;
  accent: string;
  fontSize: number;
  contentWidth: number;
  bodyFont: "sans" | "serif" | "mono";
  codeFont: string;
  openIn: "tab" | "window";
  window: WindowGeometry;
}

export interface Boot {
  settings: Settings;
  systemDark: boolean;
  perf: boolean;
}

declare global {
  interface Window {
    __MDV_BOOT__?: Boot;
  }
}

export interface OpenedDoc {
  id: number;
  path: string;
  name: string;
  html: string;
}

export type OpenOutcome =
  | ({ kind: "opened" } & OpenedDoc)
  | { kind: "existing"; id: number }
  | { kind: "elsewhere" }
  | { kind: "failed"; path: string; message: string };

export type LinkAction =
  | { kind: "open"; path: string; fragment: string }
  | { kind: "done" }
  | { kind: "failed"; message: string };

export const api = {
  boot: () => invoke<OpenOutcome[]>("boot"),
  openDoc: (path: string) => invoke<OpenOutcome>("open_doc", { path }),
  closeDoc: (id: number) => invoke<void>("close_doc", { id }),
  pickFiles: () => invoke<string[]>("pick_files"),
  render: (text: string, sourcepos: boolean) => invoke<string>("render_md", { text, sourcepos }),
  getText: (id: number) => invoke<string>("get_text", { id }),
  save: (id: number, text: string) => invoke<{ warning: string | null }>("save_doc", { id, text }),
  openLink: (id: number, href: string) => invoke<LinkAction>("open_link", { id, href }),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  newWindow: () => invoke<void>("new_window"),
  windowReady: () => invoke<void>("window_ready"),
  perfMark: (label: string) => invoke<void>("perf_mark", { label }),
};

const perfOn = !!window.__MDV_BOOT__?.perf;

/** Logs a timing mark to the Rust perf log when MDV_PERF is set. */
export function mark(label: string) {
  if (perfOn) void api.perfMark(label);
}
