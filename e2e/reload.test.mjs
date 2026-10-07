// Phase 2: auto-reload when files change on disk.

import fs from "node:fs";
import path from "node:path";
import { launch, tempFixtures, test, assert, eq, waitUntil, waitForTabs, summary, sleep } from "./harness.mjs";

const fx = tempFixtures();
const other = path.join(fx, "docs", "other.md");

const text = (page) => page.evaluate(() => document.querySelector(".markdown-body").textContent);

await test("reloads on external edits, keeps scroll and reuses unchanged nodes", async () => {
  const app = await launch({ args: [other] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.evaluate(() => {
      const pane = document.querySelector(".preview-pane");
      pane.scrollTop = 800;
      document.querySelector(".markdown-body h2").__marker = "kept";
    });
    const before = fs.readFileSync(other, "utf8");
    const t0 = Date.now();
    fs.writeFileSync(other, before.replace("First part.", "First part, edited outside."));
    await waitUntil(async () => (await text(page)).includes("edited outside"), { message: "reload" });
    const latency = Date.now() - t0;
    const r = await page.evaluate(() => ({
      scroll: document.querySelector(".preview-pane").scrollTop,
      marker: document.querySelector(".markdown-body h2").__marker,
    }));
    eq(r.scroll, 800, "scroll position kept");
    eq(r.marker, "kept", "unchanged heading node reused by morphdom");
    console.log(`        reload latency ${latency} ms`);
    assert(latency < 1000, `reload latency ${latency} ms`);
  } finally {
    await app.close();
  }
});

await test("handles editors that save by writing a temp file and renaming", async () => {
  const app = await launch({ args: [other] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    for (const n of [1, 2, 3]) {
      const tmp = other + ".tmp~";
      fs.writeFileSync(tmp, `# Replaced ${n}\n\nVia rename.\n`);
      fs.renameSync(tmp, other);
      await waitUntil(async () => (await text(page)).includes(`Replaced ${n}`), { message: `replace ${n}` });
    }
    // Then a plain write still works, so the watch survived the renames.
    fs.writeFileSync(other, "# Plain write after renames\n");
    await waitUntil(async () => (await text(page)).includes("Plain write after renames"), { message: "plain write" });
  } finally {
    await app.close();
  }
});

await test("ignores writes that don't change the content", async () => {
  const app = await launch({ args: [other] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.evaluate(() => (document.querySelector(".markdown-body").firstElementChild.__marker = 1));
    const reloadsBefore = app.perf().split("watcher: reloaded").length;
    fs.writeFileSync(other, fs.readFileSync(other));
    await sleep(600);
    eq(app.perf().split("watcher: reloaded").length, reloadsBefore, "no reload for identical content");
    eq(await page.evaluate(() => document.querySelector(".markdown-body").firstElementChild.__marker), 1, "DOM untouched");
  } finally {
    await app.close();
  }
});

await test("shows a banner when the file is deleted and recovers when it returns", async () => {
  const app = await launch({ args: [other] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    const saved = fs.readFileSync(other);
    fs.unlinkSync(other);
    await waitUntil(() => page.evaluate(() => document.querySelector(".banner")?.textContent.includes("deleted")), { message: "deleted banner" });
    eq((await waitForTabs(page, 1))[0].missing, true, "tab marked missing");
    // Same content as before the delete: must still clear the missing state.
    fs.writeFileSync(other, saved);
    await waitUntil(() => page.evaluate(() => !document.querySelector(".banner")), { message: "restored" });
    const r = await page.evaluate(() => ({ banner: !!document.querySelector(".banner"), missing: window.__mdv.tabs()[0].missing }));
    eq(r, { banner: false, missing: false }, "banner cleared");
  } finally {
    await app.close();
  }
});

await test("only reloads the document that changed", async () => {
  const sample = path.join(fx, "docs", "sample.md");
  const app = await launch({ args: [sample, other] });
  try {
    const page = await app.page();
    await waitForTabs(page, 2);
    fs.writeFileSync(other, "# Changed other\n");
    await page.keyboard.press("Control+2");
    await waitUntil(async () => (await text(page)).includes("Changed other"), { message: "inactive tab updated" });
    await page.keyboard.press("Control+1");
    assert((await text(page)).includes("Sample Document"), "sample untouched");
  } finally {
    await app.close();
  }
});

summary();
