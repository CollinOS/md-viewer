// Phase 7: large documents, end to end. Most meaningful against the release
// build: MDV_EXE=src-tauri/target/release/md-viewer.exe node e2e/run.mjs perf
// Needs `node bench/gen.mjs` first.

import fs from "node:fs";
import path from "node:path";
import { ROOT, launch, test, assert, waitForTabs, summary, sleep } from "./harness.mjs";

const files = path.join(ROOT, "bench", "files");
const release = (process.env.MDV_EXE ?? "").includes("release");
const budget = (ms) => (release ? ms : ms * 4);

if (!fs.existsSync(path.join(files, "large-1mb.md"))) {
  console.log("  skip  bench files missing, run `node bench/gen.mjs`");
  process.exit(0);
}

/** Opens a file in the running window and times it until the next painted frame. */
async function timeOpen(page, file) {
  return page.evaluate(async (p) => {
    const t0 = performance.now();
    await window.__mdv.openPaths([p]);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    return performance.now() - t0;
  }, file);
}

await test("opening large documents end to end", async () => {
  const app = await launch({ args: [path.join(files, "readme-20k.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await sleep(500);
    for (const [name, limit] of [["large-1mb.md", 300], ["code-heavy-500k.md", 300], ["huge-5mb.md", 1500]]) {
      const ms = await timeOpen(page, path.join(files, name));
      console.log(`        ${name}: ${ms.toFixed(0)} ms from request to painted (budget ${budget(limit)} ms)`);
      assert(ms < budget(limit), `${name} took ${ms.toFixed(0)} ms`);
    }
    const large = await page.evaluate(() => document.querySelector(".markdown-body").classList.contains("large"));
    assert(large, "content-visibility optimization active for big documents");
  } finally {
    await app.close();
  }
});

await test("typing stays responsive in a 1 MB document", async () => {
  const app = await launch({ args: [path.join(files, "large-1mb.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.keyboard.press("Control+E");
    await page.waitForSelector(".cm-content");
    await sleep(1000);
    // Time how long each keystroke blocks the page: a long task here is felt as lag.
    const r = await page.evaluate(async () => {
      const view = document.querySelector(".cm-content");
      view.focus();
      const blocks = [];
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        document.execCommand("insertText", false, "x");
        await new Promise((res) => requestAnimationFrame(() => res()));
        blocks.push(performance.now() - t0);
        await new Promise((res) => setTimeout(res, 30));
      }
      // Let the preview catch up, then measure how long the render took to land.
      await new Promise((res) => setTimeout(res, 1500));
      blocks.sort((a, b) => a - b);
      return { median: blocks[20], p90: blocks[36], max: blocks[39] };
    });
    console.log(`        keystroke to next frame: median ${r.median.toFixed(1)} ms, p90 ${r.p90.toFixed(1)} ms, max ${r.max.toFixed(1)} ms`);
    assert(r.p90 < budget(34), `p90 ${r.p90} ms`);
    const shown = await page.evaluate(() => document.querySelector(".markdown-body").textContent.includes("xxxxxxxxxx"));
    assert(shown, "preview caught up");
  } finally {
    await app.close();
  }
});

summary();
