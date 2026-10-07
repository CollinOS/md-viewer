// Phase 6: settings and color schemes.

import fs from "node:fs";
import path from "node:path";
import { launch, tempFixtures, test, assert, eq, waitUntil, waitForTabs, summary, sleep } from "./harness.mjs";

const fx = tempFixtures();
const sample = path.join(fx, "docs", "sample.md");
const shots = path.join(import.meta.dirname, "screenshots");
const readSettings = (app) => JSON.parse(fs.readFileSync(path.join(app.configDir, "settings.json"), "utf8"));
const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const rootVar = (page, name) => page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name);

await test("saved settings apply before the window is shown", async () => {
  const app = await launch({ args: [sample], settings: { mode: "dark", darkTheme: "nord", fontSize: 18, accent: "#ff8800" } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    eq(await theme(page), "nord", "theme");
    eq(await rootVar(page, "--font-size"), "18px", "font size");
    const r = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      link: getComputedStyle(document.querySelector(".markdown-body a:not(.anchor)")).color,
      size: getComputedStyle(document.querySelector(".markdown-body p")).fontSize,
    }));
    eq(r.bg, "rgb(46, 52, 64)", "nord background");
    eq(r.link, "rgb(255, 136, 0)", "accent override on links");
    eq(r.size, "18px", "paragraph font size");
    await page.screenshot({ path: path.join(shots, "theme-nord.png") });
  } finally {
    await app.close();
  }
});

await test("settings dialog changes apply live, persist and sync to other windows", async () => {
  const app = await launch({ args: [sample], settings: { mode: "light" } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.keyboard.press("Control+Shift+N");
    const [, other] = await app.waitForWindows(2);
    await page.bringToFront();

    await page.keyboard.press("Control+,");
    await page.waitForSelector("dialog.settings[open]");
    await page.screenshot({ path: path.join(shots, "settings-dialog.png") });

    await page.locator("dialog.settings .segmented button", { hasText: "Dark" }).click();
    eq(await theme(page), "github-dark", "dark mode applied");
    // The second theme grid is the dark one.
    await page.locator("dialog.settings .theme-grid").nth(1).locator(".theme-card", { hasText: "Dracula" }).click();
    eq(await theme(page), "dracula", "dracula applied");
    await page.locator("dialog.settings .segmented button", { hasText: "Serif" }).click();
    assert((await rootVar(page, "--body-font")).includes("Georgia"), "serif font");

    await waitUntil(() => readSettings(app).darkTheme === "dracula", { message: "persisted" });
    const s = readSettings(app);
    eq([s.mode, s.darkTheme, s.bodyFont], ["dark", "dracula", "serif"], "settings file");
    await waitUntil(async () => (await theme(other)) === "dracula", { message: "other window synced" });

    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.settings:not([open])", { state: "attached" });
  } finally {
    await app.close();
  }
});

await test("Ctrl+Plus, Ctrl+Minus and Ctrl+0 change the font size", async () => {
  const app = await launch({ args: [sample] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.keyboard.press("Control+=");
    await page.keyboard.press("Control+=");
    eq(await rootVar(page, "--font-size"), "18px", "bigger");
    await page.keyboard.press("Control+-");
    eq(await rootVar(page, "--font-size"), "17px", "smaller");
    await waitUntil(() => readSettings(app).fontSize === 17, { message: "persisted" });
    await page.keyboard.press("Control+0");
    eq(await rootVar(page, "--font-size"), "16px", "reset");
  } finally {
    await app.close();
  }
});

await test("system mode follows the OS color scheme", async () => {
  const app = await launch({ args: [sample], settings: { mode: "system", lightTheme: "solarized-light", darkTheme: "solarized-dark" } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.emulateMedia({ colorScheme: "dark" });
    await waitUntil(async () => (await theme(page)) === "solarized-dark", { message: "dark" });
    await page.emulateMedia({ colorScheme: "light" });
    await waitUntil(async () => (await theme(page)) === "solarized-light", { message: "light" });
  } finally {
    await app.close();
  }
});

await test("content width and accent reset", async () => {
  const app = await launch({ args: [sample], settings: { accent: "#ff0000", contentWidth: 0 } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    const wide = await page.evaluate(() => document.querySelector(".markdown-body").getBoundingClientRect().width);
    assert(wide > 900, `full width (${wide})`);
    await page.keyboard.press("Control+,");
    await page.locator("dialog.settings .link-btn", { hasText: "Use theme color" }).click();
    eq(await rootVar(page, "--accent"), "", "accent reset to theme");
    await waitUntil(() => readSettings(app).accent === "", { message: "persisted" });
  } finally {
    await app.close();
  }
});

await test("screenshots of every theme render without errors", async () => {
  const themes = ["github-light", "github-dark", "solarized-light", "solarized-dark", "nord", "dracula", "gruvbox-dark", "sepia"];
  const app = await launch({ args: [sample], settings: { mode: "light" } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await page.evaluate(() => document.querySelector("#code").scrollIntoView());
    for (const t of themes) {
      await page.evaluate((id) => (document.documentElement.dataset.theme = id), t);
      await sleep(50);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert(bg !== "rgba(0, 0, 0, 0)", `${t} has a background`);
      await page.screenshot({ path: path.join(shots, `theme-${t}.png`) });
    }
  } finally {
    await app.close();
  }
});

summary();
