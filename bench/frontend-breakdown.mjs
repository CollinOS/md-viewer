// Breaks down where the time goes when a large document is opened in the
// webview: IPC, HTML parsing, DOM insertion, style/layout and paint.
// Usage: node bench/frontend-breakdown.mjs [file]  (uses the release build)

import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "..");
// Must be set before the harness loads, since it reads MDV_EXE at import.
process.env.MDV_EXE ??= path.join(ROOT, "src-tauri", "target", "release", "md-viewer.exe");
const { launch, waitForTabs, sleep } = await import("../e2e/harness.mjs");
const file = process.argv[2] ?? path.join(ROOT, "bench", "files", "large-1mb.md");
const app = await launch({ args: [path.join(ROOT, "bench", "files", "readme-20k.md")] });
try {
  const page = await app.page();
  await waitForTabs(page, 1);
  await sleep(500);
  for (let i = 0; i < 3; i++) {
    const r = await page.evaluate(async (p) => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const t = [performance.now()];
      const html = await inv("render_md", { text: await inv("get_text", { id: window.__mdv.tabs()[0].id }), sourcepos: false });
      t.push(performance.now());
      // Same as the app: big file through render_md for IPC size comparison.
      const doc = await inv("open_doc", { path: p });
      t.push(performance.now());
      const tpl = document.createElement("template");
      tpl.innerHTML = doc.html ?? "";
      t.push(performance.now());
      const art = document.createElement("article");
      art.className = "markdown-body large";
      art.append(tpl.content);
      const host = document.querySelector(".doc-host");
      const old = [...host.childNodes];
      host.replaceChildren(art);
      t.push(performance.now());
      void art.offsetHeight; // style + layout
      t.push(performance.now());
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      t.push(performance.now());
      host.replaceChildren(...old);
      if (doc.id) await inv("close_doc", { id: doc.id });
      return { bytes: (doc.html ?? "").length, steps: t.slice(1).map((v, i) => +(v - t[i]).toFixed(1)), small: html.length };
    }, file);
    const [, ipc, parse, insert, layout, paint] = r.steps;
    console.log(
      `${(r.bytes / 1e6).toFixed(2)} MB html | read+render+IPC ${ipc} ms | parse ${parse} ms | insert ${insert} ms | style+layout ${layout} ms | paint ${paint} ms`,
    );
  }
} finally {
  await app.close();
}
