// Opt-in "stay ready in the background": the last window hides instead of
// exiting, and the next file opens in it.

import path from "node:path";
import { spawn } from "node:child_process";
import { EXE, launch, tempFixtures, tabs, test, assert, eq, waitUntil, waitForTabs, summary, sleep } from "./harness.mjs";

const fx = tempFixtures();
const doc = (name) => path.join(fx, "docs", name);
const visible = (page) =>
  page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label }));

function secondInstance(app, args) {
  return new Promise((resolve) => {
    spawn(EXE, args, { env: { ...process.env, MDV_CONFIG_DIR: app.configDir }, stdio: "ignore" }).on("exit", resolve);
  });
}

await test("closing the last tab parks the window, and the next file reuses it", async () => {
  const app = await launch({ args: [doc("other.md")], settings: { keepRunning: true } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.keyboard.press("Control+W");
    await waitUntil(async () => !(await visible(page)), { message: "window hidden" });
    await sleep(300);
    eq(app.child.exitCode, null, "process still running");
    eq((await tabs(page)).length, 0, "tabs cleared");
    assert(app.perf().includes("window parked"), "parked");

    const t0 = Date.now();
    await secondInstance(app, [doc("crlf.md")]);
    await waitUntil(() => visible(page), { message: "window shown again" });
    const ms = Date.now() - t0;
    const t = await waitForTabs(page, 1);
    eq(t[0].name, "crlf.md", "file opened in the parked window");
    console.log(`        launch to visible window with the file: ${ms} ms (debug build)`);
  } finally {
    await app.close();
  }
});

await test("closing the window itself also parks, and a plain launch brings it back", async () => {
  const app = await launch({ args: [doc("other.md")], settings: { keepRunning: true } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    void page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label })).catch(() => {});
    await waitUntil(async () => !(await visible(page)), { message: "window hidden" });
    eq(app.child.exitCode, null, "still running");
    await secondInstance(app, []);
    await waitUntil(() => visible(page), { message: "shown on plain launch" });
    assert(await page.evaluate(() => !document.querySelector(".empty-state").hidden), "empty state");
  } finally {
    await app.close();
  }
});

await test("with two windows open, closing one really closes it", async () => {
  const app = await launch({ args: [doc("other.md")], settings: { keepRunning: true } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.keyboard.press("Control+Shift+N");
    const [, second] = await app.waitForWindows(2);
    void second.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label })).catch(() => {});
    await app.waitForWindows(1);
    assert(await visible(page), "first window untouched");
  } finally {
    await app.close();
  }
});

summary();
