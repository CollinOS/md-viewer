# md-viewer build plan

A small, fast markdown viewer and editor for Windows and Linux, built with Tauri 2.

Performance comes first. Markdown parsing and syntax highlighting happen in Rust, the frontend is plain TypeScript with no framework, and anything heavy (the editor, Mermaid) only loads when it's actually needed.

## Status

All seven phases are built and covered by tests: 33 Rust unit tests and 49 end-to-end tests that drive the real app through WebView2's debugging port (`npm run test:rust`, `npm run test:e2e`). Linux support was added in 0.1.1 (see below).

Not covered by automated tests, so worth a quick manual check: the `Ctrl+O` file dialog (it's a native window the tests can't reach), dropping files onto the window, and double-clicking a `.md` file in Explorer after installing.

## Performance results

Measured on the release build with `node bench/startup.mjs`, `node e2e/run.mjs perf` (with `MDV_EXE` pointing at the release exe) and `cargo test --release --lib render_benchmark -- --ignored --nocapture`. Medians of 9 runs on a 16-core machine.

| Metric | Target | Measured |
| --- | --- | --- |
| Cold start to first paint, 20 KB file | under 400 ms | 429 ms (missed, see below) |
| Cold start to first paint, empty window | | 390 ms |
| Opening a file when the app is already running (new tab) | under 100 ms | 48 ms |
| Opening a file with "stay ready in the background" on | | about 80 ms |
| Switching tabs | under 16 ms | 2.4 ms |
| Rendering a 20 KB README, Rust side | under 5 ms | 3.1 ms (0.4 ms cached) |
| Rendering a 1 MB file, Rust side | under 50 ms | 43 ms (23 ms cached) |
| 1 MB file, request to painted, end to end | under 300 ms | 252 ms |
| Typing in a 1 MB document, keystroke to next frame | no dropped frames | 3.9 ms median, 4.7 ms p90 |
| Auto-reload after an outside edit | | about 70 ms |
| Memory, one document open (private bytes, all processes) | 60 to 100 MB | 177 MB (missed, see below) |
| Installer size | under 10 MB | 4.2 MB |

**Cold start.** About 300 ms of a cold start is WebView2 creating its browser process and controller, which happens before any of our code can run. Everything after that (reading, rendering, inserting and painting a 20 KB file) takes about 120 ms. WebView2 flags were tested (`bench/flags.mjs`) and none made startup faster. The opt-in "stay ready in the background" setting is the answer for people who want instant opens: the last window hides instead of exiting and WebView2 is asked to drop to low memory, so the next file opens in about 80 ms.

**Memory.** The 60 to 100 MB estimate was wrong. WebView2 itself runs 6 to 7 processes and uses about 160 to 180 MB of private memory for an almost empty page. Running the GPU in-process saves about 20 MB, but a GPU driver crash would then take down the whole app, so it isn't enabled.

## Stack

- **Shell:** Tauri 2 (WebView2 on Windows, WebKitGTK on Linux)
- **Markdown:** `comrak` with GFM extensions (tables, task lists, strikethrough, autolinks, footnotes, alerts, header IDs)
- **Highlighting:** `syntect` plus `two-face` for the extended syntax set. Scopes are mapped to short token elements like `<hl-k>fn</hl-k>` through an internal theme, and colors come from CSS, so switching themes never re-renders. Code blocks are highlighted in parallel across cores and cached by content.
- **File watching:** `notify` with a debouncer, watching each document's parent folder
- **Frontend:** Vite and plain TypeScript, `morphdom` for DOM diffing
- **Editor:** CodeMirror 6, lazy-loaded (and preloaded in the background 1.5 s after startup)
- **Diagrams:** Mermaid, lazy-loaded only if a document has a diagram, themed from the active color scheme
- **Plugins:** `single-instance`, `dialog`, `opener`

## Changes from the original plan

- **Highlighting output.** syntect's standard HTML output nests a span per scope and made a 1 MB file into 4.5 MB of HTML, which slowed every step in the webview. The token-element output is about 2x the markdown size, which cut the 1 MB open from 344 ms to 252 ms.
- **Parallel, cached highlighting.** Highlighting took 120 of the 145 ms for a 1 MB file on one core. Spreading blocks across cores and caching by content fixed that, and live preview now only re-highlights blocks that changed.
- **No GFM tag filter.** The current comrak release no longer has one, so the frontend strips `script`, `style`, `iframe`, `object`, `embed`, `meta`, `base`, `link`, `form` and similar tags before inserting a document. The CSP still blocks all inline scripts.
- **Local file access.** `mdfile://` serves media files (images, audio, video) from anywhere on disk rather than only from the document's folder. Restricting it to the folder broke common `../images` layouts, and since no script can run in a document, the folder limit added little.
- **Window position.** Saved in `settings.json` by the app itself instead of `tauri-plugin-window-state`, which would have restored windows as visible before their content was ready.
- **Live preview timing.** An adaptive delay (about 1.5x the last render time, between 10 and 300 ms) instead of a fixed 150 ms debounce, so small files update almost instantly and large ones never queue up renders.
- **Mermaid.** Diagrams are drawn with `mermaid.render` and inserted by the app. `mermaid.run` could redraw diagrams it wasn't asked to, and morphdom removed rendered SVGs because of their generated ids.
- **Background mode.** Added as an opt-in setting (see cold start above).

## Phases

### Phase 0: Setup
- [x] Update Rust (1.99.0) and install the MSVC build tools
- [x] Scaffold Tauri 2 with Vite and plain TypeScript
- [x] Release profile: LTO, one codegen unit, `opt-level = 3`, `panic = "abort"`, stripped
- [x] CSP with no inline scripts; inline styles allowed for Mermaid, CodeMirror and raw HTML
- [x] Capability file with only the permissions the frontend uses

### Phase 1: Viewer core
- [x] Render in Rust, open from the command line, `Ctrl+O` dialog, drag and drop
- [x] Encoding detection (UTF-8, UTF-8 BOM, UTF-16 LE/BE, Windows-1252) and line endings remembered for saving
- [x] GitHub-style stylesheet on CSS variables, highlighted code
- [x] Relative images through `mdfile://`, including raw `<img>` tags and `/`-rooted paths (resolved from the git root)
- [x] Links: external in the browser, `.md` in a tab (with `#fragment`), other files revealed in Explorer, anchors scroll
- [x] Navigation blocked in Rust, so documents can't move the webview off the app
- [x] Window hidden until the first render, with a fallback timer

### Phase 2: Auto-reload
- [x] Watch parent folders, compare content hashes, re-render and patch with morphdom, scroll kept
- [x] Deleted files are flagged with a banner and recover when the file comes back

### Phase 3: Tabs, single instance and file association
- [x] Tab bar, keyboard shortcuts, middle-click close, drag to reorder, reopen closed tab
- [x] Single instance: Explorer opens go to the running window as tabs, or new windows if set
- [x] Already open files are focused instead of duplicated
- [x] Window position and size remembered, off-screen positions reset
- [x] `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn` registered by the per-user NSIS installer

### Phase 4: Editing
- [x] `Ctrl+E` split view with lazy CodeMirror, live preview, editor-to-preview scroll sync
- [x] `Ctrl+S` keeps encoding, BOM and line endings, writes atomically
- [x] Own saves don't trigger reloads; outside changes while editing offer "Load theirs" or "Keep mine"
- [x] Prompts before closing tabs or windows with unsaved changes; per-tab undo history

### Phase 5: Mermaid
- [x] Lazy-loaded, themed from the active color scheme, unchanged diagrams kept across edits

### Phase 6: Settings
- [x] Eight themes, separate light and dark picks, system mode, accent, font size, width, body and code fonts
- [x] Applied before the first paint, saved to `settings.json`, synced across windows
- [x] Native title bar follows light or dark

### Phase 7: Performance
- [x] Timing marks (`MDV_PERF`), benchmark scripts in `bench/`, large-file tests in `e2e/perf.test.mjs`
- [x] `content-visibility: auto` for documents over 200 KB
- [x] Editor and Mermaid in separate chunks; main bundle is 44 KB
- [x] Background mode instead of an always-on pre-warmed window

### Linux (0.1.1)
- [x] Image URLs from `convertFileSrc`, since the protocol is `http://mdfile.localhost` on Windows and `mdfile://localhost` elsewhere
- [x] Dark mode from the desktop portal, with a 150 ms timeout
- [x] Leading-slash links resolve from the repo root on every platform
- [x] Custom desktop entry with `%F`, so file managers pass the opened file
- [x] CI: Rust tests on Windows and Ubuntu, a Linux smoke test under Xvfb (`e2e/smoke.mjs`), and a desktop entry check (`scripts/check-linux-packages.sh`)
- [x] Release workflow: tag `v*` builds the NSIS installer plus deb, rpm and AppImage into a draft release
- [ ] Try the Linux build on a real desktop (file manager integration, drag and drop, file dialog)
- [ ] Port a subset of the e2e tests to Linux with tauri-driver

### Later, maybe
- Find in the preview (`Ctrl+F` currently works in the editor only)
- Table of contents sidebar
- Recent files list
- Export to HTML or PDF
- macOS build (needs the Apple open-file event, Cmd shortcuts, an app menu, and ideally signing and notarization)
