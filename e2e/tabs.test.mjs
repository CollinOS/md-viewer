// Phase 3: tabs, windows, single instance.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EXE, launch, tempFixtures, tabs, test, assert, eq, waitUntil, waitForTabs, summary, sleep } from "./harness.mjs";

const fx = tempFixtures();
const doc = (name) => path.join(fx, "docs", name);
const names = async (page) => (await tabs(page)).map((t) => t.name);
const activeName = async (page) => (await tabs(page)).find((t) => t.active)?.name;

/** Runs a second copy of the app the way Explorer would. */
function secondInstance(app, args) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const p = spawn(EXE, args, { env: { ...process.env, MDV_CONFIG_DIR: app.configDir }, stdio: "ignore" });
    p.on("exit", (code) => resolve({ code, ms: Date.now() - started }));
    p.on("error", reject);
  });
}

await test("keyboard tab navigation", async () => {
  const app = await launch({ args: [doc("sample.md"), doc("other.md"), doc("crlf.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 3);
    eq(await activeName(page), "sample.md", "first file active at startup");
    await page.keyboard.press("Control+Tab");
    eq(await activeName(page), "other.md", "Ctrl+Tab");
    await page.keyboard.press("Control+Shift+Tab");
    await page.keyboard.press("Control+Shift+Tab");
    eq(await activeName(page), "crlf.md", "Ctrl+Shift+Tab wraps");
    await page.keyboard.press("Control+1");
    eq(await activeName(page), "sample.md", "Ctrl+1");
    await page.keyboard.press("Control+9");
    eq(await activeName(page), "crlf.md", "Ctrl+9 is last");
    await page.keyboard.press("Control+PageUp");
    eq(await activeName(page), "other.md", "Ctrl+PageUp");
    eq(await page.evaluate(() => document.title), "other.md - MD Viewer", "title follows tab");
  } finally {
    await app.close();
  }
});

await test("each tab keeps its own scroll position", async () => {
  const app = await launch({ args: [doc("sample.md"), doc("other.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 2);
    await page.evaluate(() => (document.querySelector(".preview-pane").scrollTop = 300));
    await page.keyboard.press("Control+2");
    await page.evaluate(() => (document.querySelector(".preview-pane").scrollTop = 1200));
    await page.keyboard.press("Control+1");
    eq(await page.evaluate(() => document.querySelector(".preview-pane").scrollTop), 300, "tab 1 scroll");
    await page.keyboard.press("Control+2");
    eq(await page.evaluate(() => document.querySelector(".preview-pane").scrollTop), 1200, "tab 2 scroll");
  } finally {
    await app.close();
  }
});

await test("tab switching is fast", async () => {
  const app = await launch({ args: [doc("sample.md"), doc("other.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 2);
    const ms = await page.evaluate(async () => {
      const times = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }));
        document.querySelector(".markdown-body").getBoundingClientRect(); // force layout
        times.push(performance.now() - t0);
        await new Promise((r) => requestAnimationFrame(r));
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)];
    });
    console.log(`        median tab switch ${ms.toFixed(2)} ms`);
    assert(ms < 16, `tab switch ${ms} ms`);
  } finally {
    await app.close();
  }
});

await test("close, reopen, middle-click close", async () => {
  const app = await launch({ args: [doc("sample.md"), doc("other.md"), doc("crlf.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 3);
    await page.keyboard.press("Control+2");
    await page.keyboard.press("Control+W");
    eq(await names(page), ["sample.md", "crlf.md"], "Ctrl+W closed the active tab");
    eq(await activeName(page), "crlf.md", "neighbor to the right activated");
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 3);
    eq(await activeName(page), "other.md", "Ctrl+Shift+T reopened it");
    const box = await page.locator(".tab").nth(0).boundingBox();
    await page.mouse.click(box.x + 30, box.y + box.height / 2, { button: "middle" });
    await waitForTabs(page, 2);
    eq(await names(page), ["crlf.md", "other.md"], "middle click closed the first tab");
    await page.locator(".tab").nth(0).locator(".tab-close").click();
    eq(await names(page), ["other.md"], "close button");
  } finally {
    await app.close();
  }
});

await test("drag to reorder tabs", async () => {
  const app = await launch({ args: [doc("sample.md"), doc("other.md"), doc("crlf.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 3);
    const first = await page.locator(".tab").nth(0).boundingBox();
    const last = await page.locator(".tab").nth(2).boundingBox();
    await page.mouse.move(first.x + 20, first.y + 10);
    await page.mouse.down();
    await page.mouse.move(first.x + 60, first.y + 10, { steps: 4 });
    await page.mouse.move(last.x + last.width - 10, last.y + 10, { steps: 8 });
    await page.mouse.up();
    eq(await names(page), ["other.md", "crlf.md", "sample.md"], "order after drag");
    eq(await activeName(page), "sample.md", "dragged tab is active");
    await page.keyboard.press("Control+1");
    eq(await activeName(page), "other.md", "Ctrl+1 follows new order");
  } finally {
    await app.close();
  }
});

await test("closing the last tab closes the window and saves its position", async () => {
  const app = await launch({ args: [doc("other.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.keyboard.press("Control+W");
    await waitUntil(() => app.child.exitCode !== null, { message: "app exit" });
    const s = JSON.parse(fs.readFileSync(path.join(app.configDir, "settings.json"), "utf8"));
    assert(typeof s.window.x === "number" && typeof s.window.y === "number", `position saved: ${JSON.stringify(s.window)}`);
    assert(s.window.width >= 420, "size saved");
  } finally {
    await app.close();
  }
});

await test("a second launch opens its file as a tab in the running window", async () => {
  const app = await launch({ args: [doc("sample.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    const t0 = Date.now();
    const second = await secondInstance(app, [doc("other.md")]);
    await waitForTabs(page, 2);
    const shown = Date.now() - t0;
    console.log(`        second instance exited in ${second.ms} ms, tab visible after ${shown} ms (debug build)`);
    eq(second.code, 0, "second instance exits cleanly");
    eq(await activeName(page), "other.md", "new tab active");
    eq((await app.pages()).length, 1, "still one window");

    // Launching with a file that's already open just switches to it.
    await page.keyboard.press("Control+1");
    await secondInstance(app, [doc("other.md")]);
    await waitUntil(async () => (await activeName(page)) === "other.md", { message: "switched to existing tab" });
    eq((await tabs(page)).length, 2, "no duplicate tab");

    // Relative paths resolve against the second instance's working folder.
    await new Promise((resolve) => {
      spawn(EXE, ["crlf.md"], { cwd: path.join(fx, "docs"), env: { ...process.env, MDV_CONFIG_DIR: app.configDir }, stdio: "ignore" }).on("exit", resolve);
    });
    await waitForTabs(page, 3);
  } finally {
    await app.close();
  }
});

await test("Ctrl+Shift+N and the open-in-new-window setting create windows", async () => {
  const app = await launch({ args: [doc("sample.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.keyboard.press("Control+Shift+N");
    const [, second] = await app.waitForWindows(2);
    eq((await tabs(second)).length, 0, "new window is empty");
    assert(await second.evaluate(() => !document.querySelector(".empty-state").hidden), "empty state in new window");

    // Switch the setting, then open from "Explorer".
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("save_settings", { settings: { ...window.__MDV_BOOT__.settings, openIn: "window" } }));
    await sleep(200);
    await secondInstance(app, [doc("crlf.md")]);
    const pages = await app.waitForWindows(3);
    const counts = await Promise.all(pages.map(async (p) => (await tabs(p)).map((t) => t.name)));
    assert(counts.some((n) => n.length === 1 && n[0] === "crlf.md"), `crlf.md in its own window: ${JSON.stringify(counts)}`);

    // A file already open in another window focuses that window instead.
    await secondInstance(app, [doc("sample.md")]);
    await sleep(500);
    eq((await app.pages()).length, 3, "no window for an already open file");
    // And opening it from a different window doesn't duplicate it.
    const outcome = await second.evaluate((p) => window.__TAURI_INTERNALS__.invoke("open_doc", { path: p }), doc("sample.md"));
    eq(outcome.kind, "elsewhere", "open_doc reports the other window");
  } finally {
    await app.close();
  }
});

await test("window position is restored on the next launch", async () => {
  const settings = { window: { x: 140, y: 90, width: 900, height: 650, maximized: false } };
  const app = await launch({ args: [doc("other.md")], settings });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    const r = await page.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.innerWidth, h: window.outerHeight }));
    assert(Math.abs(r.x - 140) <= 16 && Math.abs(r.y - 90) <= 40, `position ${JSON.stringify(r)}`);
    assert(Math.abs(r.w - 900) <= 20, `width ${r.w}`);
  } finally {
    await app.close();
  }
});

await test("an off-screen saved position falls back to centered", async () => {
  const settings = { window: { x: -30000, y: -30000, width: 900, height: 650, maximized: false } };
  const app = await launch({ args: [doc("other.md")], settings });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    const r = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
    assert(r.x > -1000 && r.y > -1000, `window on screen: ${JSON.stringify(r)}`);
  } finally {
    await app.close();
  }
});

summary();
