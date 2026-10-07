# md-viewer build plan

A small, fast markdown viewer and editor for Windows, built with Tauri 2.

Performance comes first. Markdown parsing and syntax highlighting happen in Rust, the frontend is plain TypeScript with no framework, and anything heavy (the editor, Mermaid) only loads when it's actually needed.

## Performance targets

We measure these in phase 7 and come back to them whenever something feels slow.

| Metric | Target |
| --- | --- |
| Cold start to first paint (release build) | under 400 ms |
| Opening a file when the app is already running (new tab) | under 100 ms |
| Opening a file in a new window (if that setting is on, WebView2 warm) | under 250 ms |
| Switching tabs | under 16 ms (one frame) |
| Rendering a typical README (about 20 KB), Rust side | under 5 ms |
| Rendering a large file (about 1 MB), Rust side | under 50 ms |
| Large file (about 1 MB), file read to painted, end to end | under 300 ms |
| Live preview update while typing | no dropped frames, 150 ms debounce |
| Idle memory, viewer only | as low as WebView2 allows (around 60 to 100 MB) |
| Installer size | under 10 MB |

Tabs are faster than windows because a new tab reuses the existing webview instead of starting another one.

## Stack

- **Shell:** Tauri 2 (WebView2 on Windows)
- **Markdown:** `comrak` with GFM extensions (tables, task lists, strikethrough, autolinks, footnotes, alerts, header IDs). We picked it over `pulldown-cmark` because it renders closer to GitHub. If phase 7 shows it's a bottleneck we can switch.
- **Highlighting:** `syntect` plus `two-face` for the extended syntax set (TypeScript, TOML, Dockerfile, and others that syntect leaves out). Highlighting is wired into comrak's syntax highlighter hook and outputs CSS classes instead of inline styles, so changing the color scheme never requires a re-render. The syntax set loads once, lazily, and stays in memory.
- **File watching:** `notify` with a debouncer, watching the file's parent folder
- **Frontend:** Vite and plain TypeScript, `morphdom` for DOM diffing
- **Editor:** CodeMirror 6, lazy-loaded
- **Diagrams:** Mermaid, lazy-loaded only if the document has a mermaid block
- **Plugins:** `single-instance`, `dialog`, `opener` (for external links), `window-state`

## Architecture notes

- **State is per document from day one.** Each open document has its own ID, file path, watcher, encoding info, unsaved-changes state, and last-saved hash, stored in Rust. Windows hold a list of document IDs (their tabs). Phase 1 only shows one document, but building it this way means phase 3 adds tabs and windows without a refactor.
- **Inactive tabs keep their rendered DOM detached in memory**, along with their scroll position, so switching tabs is just swapping a node. The editor works the same way: one CodeMirror view, with a saved `EditorState` per tab (which also keeps undo history per tab). If memory becomes a problem with many large tabs, we can drop the DOM of old tabs and re-render them when they're opened.
- **Local files go through a custom protocol (`mdfile://`), not Tauri's asset protocol.** It only serves files inside the open document's folder (and its subfolders). Tauri's asset protocol would need an allow-everything scope, since documents can live anywhere.
- **Raw HTML is allowed in documents, with three safeguards:** a CSP with no scripts allowed, comrak's GFM tag filter (which neutralizes `<script>`, `<iframe>`, and similar tags), and a Rust navigation handler that blocks the webview from leaving the app's own pages (which stops meta refreshes and stray links).
- **Inline styles need a CSP decision up front.** Tauri adds nonces to `style-src` at build time, and browsers ignore `'unsafe-inline'` once a nonce is present. Mermaid, CodeMirror, and raw HTML `style=""` attributes all need inline styles, so we set `dangerousDisableAssetCspModification: ["style-src"]` and allow `'unsafe-inline'` for styles only. Scripts stay strict.

## Phases

### Phase 0: Setup
- [x] Update Rust (now 1.99.0)
- [ ] Scaffold a Tauri 2 app with the vanilla TS template
- [ ] `git init`, `.gitignore`
- [ ] Release profile in `Cargo.toml`: `lto = true`, `codegen-units = 1`, `opt-level = 3`, `panic = "abort"`, `strip = true`
- [ ] CSP in `tauri.conf.json` as described in the architecture notes, plus a separate `devCsp` that allows Vite's dev server
- [ ] Capability file granting only the plugin permissions we use (dialog open/save, opener for http/https/mailto links, window-state)

### Phase 1: Viewer core
- [ ] Rust command `open_file(path)` that reads the file and returns rendered HTML
- [ ] File decoding: detect a UTF-8 or UTF-16 BOM, otherwise try UTF-8 and fall back to Windows-1252 (`encoding_rs`). Remember the encoding, BOM, and line endings (CRLF or LF) for saving later.
- [ ] Take the file path from the command line arguments at startup
- [ ] `Ctrl+O` opens a file dialog, and dropping a file on the window opens it
- [ ] GitHub-style stylesheet built on CSS variables (sets up phase 6)
- [ ] Code highlighting through comrak's syntect hook, using CSS classes
- [ ] Relative URLs: parse the rendered HTML into an inert `<template>` (so nothing loads yet) and rewrite relative `src` and `href` values to `mdfile://` before inserting. This covers both markdown images and raw HTML `<img>` tags.
- [ ] Links: external URLs open in the default browser, relative `.md` links open in the viewer, `#anchors` scroll to the matching heading ID
- [ ] Block webview navigation in Rust (`on_navigation`) for anything other than the app's own URL
- [ ] Window title shows the file name
- [ ] Startup without a white flash: the window starts hidden with its background color set to the theme background, appears after the first render, and has a 500 ms fallback that shows it anyway if the frontend fails

### Phase 2: Auto-reload
- [ ] Watch the file's parent folder (not recursive) and filter events by file name, so saves that replace the file are still caught
- [ ] On change, re-read and hash the file. If the hash matches what's displayed, do nothing.
- [ ] Otherwise re-render in Rust and send the HTML to the frontend as an event
- [ ] Patch the DOM with `morphdom` and keep the scroll position
- [ ] Switching files stops the old watcher and starts a new one, and closing a tab stops its watcher

### Phase 3: Tabs, single instance, and file association
- [ ] Tab bar: file name, unsaved dot, close button, tooltip with the full path
- [ ] Shortcuts: `Ctrl+Tab` and `Ctrl+Shift+Tab` to cycle, `Ctrl+1` to `Ctrl+9` to jump, `Ctrl+W` to close, middle-click to close, `Ctrl+Shift+T` to reopen the last closed tab
- [ ] Drag tabs to reorder them within a window
- [ ] Closing a tab with unsaved changes prompts first, and closing the last tab closes the window
- [ ] Register `tauri-plugin-single-instance` before any other plugin, so a second launch passes its file path to the running process
- [ ] By default, files open as a new tab in the most recently focused window
- [ ] Setting to open files in a new window instead, and `Ctrl+Shift+N` opens a new window either way
- [ ] Opening a file that's already open switches to its tab (and focuses its window) instead of opening a duplicate
- [ ] Remember window size and position (`window-state`)
- [ ] Not planned for now: dragging a tab out into its own window, since that's much more complex across separate webviews
- [ ] Register `.md` and `.markdown` in `tauri.conf.json` `fileAssociations`
- [ ] Build the NSIS installer and test from Explorer. Windows 11 doesn't let installers set themselves as the default app, so this means choosing md-viewer once through "Open with" and selecting "Always". During development, test with `cargo tauri dev -- -- path\to\file.md` instead.

### Phase 4: Editing
- [ ] `Ctrl+E` toggles between view mode and a split edit view
- [ ] Load CodeMirror 6 with a dynamic `import()` on first use, with markdown language support only
- [ ] Debounced live preview through the same Rust render command, patched with `morphdom`
- [ ] `Ctrl+S` saves through a Rust command that restores the original encoding, BOM, and line endings (CodeMirror always uses LF internally), then writes atomically: write a temp file in the same folder, then replace the original
- [ ] Store the hash of what we saved. The watcher ignores events where the file's hash matches it, so our own saves don't trigger a reload. The watcher also ignores our temp file.
- [ ] Dirty indicator in the title (`*`), and a prompt before closing a tab or window with unsaved changes
- [ ] If the file changes on disk while there are unsaved edits, prompt (keep mine, load theirs) instead of overwriting either version
- [ ] Optional: synced scrolling between editor and preview

### Phase 5: Mermaid
- [ ] Rust outputs mermaid code blocks as `<pre class="mermaid" data-hash="...">` instead of highlighting them
- [ ] The frontend imports Mermaid only when at least one block exists
- [ ] morphdom skips diagram nodes whose `data-hash` hasn't changed. Without this, every update would revert the rendered SVG back to source text. Only changed diagrams re-render.
- [ ] Mermaid's theme follows the app's light or dark mode

### Phase 6: Settings and color schemes
- [ ] All colors defined as CSS variables, so a theme is just a set of variables
- [ ] Each preset includes a matching syntect color scheme, generated as CSS classes at build time
- [ ] Presets: GitHub Light, GitHub Dark, Solarized Light, Solarized Dark, Nord
- [ ] Mode: light, dark, or follow the system
- [ ] Adjustable accent color, font size, content width, and code font
- [ ] Settings panel (`Ctrl+,`) that applies changes live
- [ ] Settings saved as JSON in the app config folder. Rust reads them at startup, sets the window background color, and injects the theme through an initialization script, so the first paint already uses the right theme.

### Phase 7: Performance pass
- [ ] Timing logs: process start, window shown, file read, parse, highlight, IPC, DOM insert, first paint
- [ ] Test files: a small README, a 1 MB file, a code-heavy file (to measure syntect), a file with many images, and a CRLF file and a UTF-16 file to check that saving round-trips them correctly
- [ ] Measure against the targets above, end to end, not just the Rust side
- [ ] If large files are slow to paint, try `content-visibility: auto` on top-level blocks before anything more complex
- [ ] Check bundle size and make sure CodeMirror and Mermaid stay in separate chunks
- [ ] If cold start is still the bottleneck, consider a hidden pre-warmed window (costs idle memory, so only if the numbers justify it)

### Later, maybe
- Table of contents sidebar
- Find in document (`Ctrl+F`)
- Recent files list
- Export to HTML or PDF
- Linux build through GitHub Actions
