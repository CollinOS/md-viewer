// Phase 4: editing and saving.

import fs from "node:fs";
import path from "node:path";
import { launch, tempFixtures, tabs, test, assert, eq, waitUntil, waitForTabs, summary, sleep } from "./harness.mjs";

const fresh = () => tempFixtures();
const preview = (page) => page.evaluate(() => document.querySelector(".markdown-body").textContent);
const editorText = (page) => page.evaluate(() => window.__mdv.editorText());

async function startEditing(page) {
  await page.keyboard.press("Control+E");
  await page.waitForSelector(".cm-content", { state: "visible" });
  await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains("cm-content")), { message: "editor focus" });
}

async function clickButton(page, label) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForSelector("dialog", { state: "detached" });
}

await test("edit, live preview, dirty marker, save", async () => {
  const fx = fresh();
  const file = path.join(fx, "docs", "other.md");
  const app = await launch({ args: [file] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    eq(await editorText(page), fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), "editor shows file text");

    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    await page.keyboard.type(" Live");
    await waitUntil(async () => (await preview(page)).includes("Other Document Live"), { message: "live preview" });
    await waitUntil(async () => (await tabs(page))[0].dirty, { message: "dirty" });
    assert((await page.evaluate(() => document.title)).startsWith("● "), "title shows unsaved marker");

    const reloadsBefore = app.perf().split("watcher: reloaded").length;
    await page.keyboard.press("Control+S");
    await waitUntil(async () => !(await tabs(page))[0].dirty, { message: "clean after save" });
    assert(fs.readFileSync(file, "utf8").startsWith("# Other Document Live\r\n"), "saved to disk, CRLF kept");
    await sleep(500);
    eq(app.perf().split("watcher: reloaded").length, reloadsBefore, "own save didn't trigger a reload");
    eq(await page.evaluate(() => !!document.querySelector(".banner")), false, "no conflict banner after own save");
    eq(fs.readdirSync(path.dirname(file)).filter((f) => f.includes("mdv-tmp")).length, 0, "no temp files left");
  } finally {
    await app.close();
  }
});

await test("undoing back to the saved text clears the dirty marker", async () => {
  const fx = fresh();
  const app = await launch({ args: [path.join(fx, "docs", "other.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    await page.keyboard.type("abc");
    await waitUntil(async () => (await tabs(page))[0].dirty, { message: "dirty" });
    await page.keyboard.press("Control+Z");
    await waitUntil(async () => !(await tabs(page))[0].dirty, { message: "clean after undo" });
  } finally {
    await app.close();
  }
});

await test("saving keeps CRLF line endings and UTF-16 encoding", async () => {
  const fx = fresh();
  const crlf = path.join(fx, "docs", "crlf.md");
  const utf16 = path.join(fx, "docs", "utf16.md");
  const app = await launch({ args: [crlf, utf16] });
  try {
    const page = await app.page();
    await waitForTabs(page, 2);
    for (const n of [1, 2]) {
      await page.keyboard.press(`Control+${n}`);
      await startEditing(page);
      await page.keyboard.press("Control+End");
      await page.keyboard.type("Added line\nAnother");
      await page.keyboard.press("Control+S"); // immediately, before the preview catches up
      await sleep(400);
      eq((await tabs(page))[n - 1].dirty, false, `saved ${n}`);
    }
    const a = fs.readFileSync(crlf, "latin1");
    assert(a.endsWith("Line two\r\nAdded line\r\nAnother"), `crlf kept: ${JSON.stringify(a)}`);
    assert(!/[^\r]\n/.test(a), "no bare LF");
    const b = fs.readFileSync(utf16);
    eq([b[0], b[1]], [0xff, 0xfe], "UTF-16 BOM kept");
    const decoded = b.subarray(2).toString("utf16le");
    assert(decoded.includes("Café naïve\r\nAdded line\r\nAnother"), `utf-16 content: ${JSON.stringify(decoded)}`);
  } finally {
    await app.close();
  }
});

await test("outside edits update a clean editor and keep the cursor", async () => {
  const fx = fresh();
  const file = path.join(fx, "docs", "other.md");
  const app = await launch({ args: [file] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    await page.keyboard.press("Control+End");
    const cursorBefore = await page.evaluate(() => window.getSelection().focusNode?.textContent);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("First part.", "First part, from outside."));
    await waitUntil(async () => (await editorText(page))?.includes("from outside"), { message: "editor updated" });
    await waitUntil(async () => (await preview(page)).includes("from outside"), { message: "preview updated" });
    eq((await tabs(page))[0].dirty, false, "still clean");
    eq(await page.evaluate(() => window.getSelection().focusNode?.textContent), cursorBefore, "cursor stayed at the end");
  } finally {
    await app.close();
  }
});

await test("outside edits while dirty ask before replacing anything", async () => {
  const fx = fresh();
  const file = path.join(fx, "docs", "other.md");
  const app = await launch({ args: [file] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("MINE ");
    await waitUntil(async () => (await tabs(page))[0].dirty, { message: "dirty" });

    fs.writeFileSync(file, "# Theirs v1\n");
    await page.waitForSelector(".banner");
    assert((await editorText(page)).startsWith("MINE "), "my edits untouched");
    await page.locator(".banner button", { hasText: "Keep mine" }).click();
    eq(await page.evaluate(() => !!document.querySelector(".banner")), false, "banner dismissed");
    assert((await tabs(page))[0].dirty, "still dirty");

    fs.writeFileSync(file, "# Theirs v2\n");
    await page.waitForSelector(".banner");
    await page.locator(".banner button", { hasText: "Load theirs" }).click();
    await waitUntil(async () => (await editorText(page)) === "# Theirs v2\n", { message: "loaded theirs" });
    await waitUntil(async () => (await preview(page)).includes("Theirs v2"), { message: "preview shows theirs" });
    eq((await tabs(page))[0].dirty, false, "clean after loading theirs");
  } finally {
    await app.close();
  }
});

await test("closing a tab with unsaved edits asks first", async () => {
  const fx = fresh();
  const file = path.join(fx, "docs", "other.md");
  const app = await launch({ args: [file, path.join(fx, "docs", "crlf.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 2);
    await startEditing(page);
    await page.keyboard.type("unsaved ");
    await waitUntil(async () => (await tabs(page))[0].dirty, { message: "dirty" });

    await page.keyboard.press("Control+W");
    await page.waitForSelector("dialog.confirm");
    await clickButton(page, "Cancel");
    eq((await tabs(page)).length, 2, "cancel keeps the tab");

    await page.keyboard.press("Control+W");
    await page.waitForSelector("dialog.confirm");
    await clickButton(page, "Save");
    await waitForTabs(page, 1);
    assert(fs.readFileSync(file, "utf8").startsWith("unsaved "), "Save wrote the file");
  } finally {
    await app.close();
  }
});

await test("closing the window with unsaved edits asks first", async () => {
  const fx = fresh();
  const file = path.join(fx, "docs", "other.md");
  const app = await launch({ args: [file] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    await page.keyboard.type("x");
    await waitUntil(async () => (await tabs(page))[0].dirty, { message: "dirty" });
    const closeWindow = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label }));
    void closeWindow().catch(() => {});
    await page.waitForSelector("dialog.confirm");
    await clickButton(page, "Cancel");
    await sleep(300);
    eq(app.child.exitCode, null, "still running after cancel");

    void closeWindow().catch(() => {});
    await page.waitForSelector("dialog.confirm");
    await page.getByRole("button", { name: "Don't save", exact: true }).click();
    await waitUntil(() => app.child.exitCode !== null, { message: "exit after don't save" });
    assert(!fs.readFileSync(file, "utf8").startsWith("x"), "nothing written");
  } finally {
    await app.close();
  }
});

await test("saving a read-only file shows an error and stays dirty", async () => {
  const fx = fresh();
  const file = path.join(fx, "docs", "other.md");
  fs.chmodSync(file, 0o444);
  const app = await launch({ args: [file] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    await page.keyboard.type("x");
    await waitUntil(async () => (await tabs(page))[0].dirty, { message: "dirty" });
    await page.keyboard.press("Control+S");
    const msg = await waitUntil(() => page.evaluate(() => document.querySelector(".toast.error")?.textContent), { message: "error toast" });
    assert(/read-only/i.test(msg), msg);
    assert((await tabs(page))[0].dirty, "still dirty");
  } finally {
    fs.chmodSync(file, 0o644);
    await app.close();
  }
});

await test("leaving edit mode keeps edits, and each tab has its own undo history", async () => {
  const fx = fresh();
  const app = await launch({ args: [path.join(fx, "docs", "other.md"), path.join(fx, "docs", "crlf.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 2);
    await startEditing(page);
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("ONE ");
    await page.keyboard.press("Control+2");
    await startEditing(page);
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("TWO ");
    await page.keyboard.press("Control+1");
    await page.waitForSelector(".cm-content");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Z");
    await waitUntil(async () => !(await editorText(page)).startsWith("ONE"), { message: "undo in tab 1" });
    await page.keyboard.press("Control+2");
    assert((await editorText(page)).startsWith("TWO "), "tab 2 edit untouched by tab 1 undo");
    await page.keyboard.press("Control+E");
    eq(await page.evaluate(() => document.querySelector(".editor-pane").hidden), true, "editor hidden");
    assert((await preview(page)).includes("TWO"), "preview keeps the edit");
    assert((await tabs(page))[1].dirty, "still dirty after leaving edit mode");
  } finally {
    await app.close();
  }
});

await test("scrolling the editor scrolls the preview", async () => {
  const fx = fresh();
  const app = await launch({ args: [path.join(fx, "docs", "other.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    await waitUntil(() => page.evaluate(() => !!document.querySelector(".markdown-body [data-sourcepos]")), { message: "sourcepos render" });
    await page.evaluate(() => {
      const s = document.querySelector(".cm-scroller");
      s.scrollTop = s.scrollHeight / 2;
    });
    await waitUntil(() => page.evaluate(() => document.querySelector(".preview-pane").scrollTop > 200), { message: "preview followed" });
  } finally {
    await app.close();
  }
});

await test("typing latency on a typical document", async () => {
  const fx = fresh();
  const app = await launch({ args: [path.join(fx, "docs", "sample.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await startEditing(page);
    await page.keyboard.press("Control+End");
    const times = [];
    for (let i = 0; i < 10; i++) {
      const word = `zq${i}x`;
      const t0 = Date.now();
      await page.keyboard.type(` ${word}`);
      await page.waitForFunction((w) => document.querySelector(".markdown-body").textContent.includes(w), word, { polling: "raf" });
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`        keystroke to preview: median ${times[5]} ms, max ${times[9]} ms (debug build)`);
    assert(times[5] < 150, `median ${times[5]} ms`);
  } finally {
    await app.close();
  }
});

summary();
