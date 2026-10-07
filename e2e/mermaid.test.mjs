// Phase 5: Mermaid diagrams.

import fs from "node:fs";
import path from "node:path";
import { launch, tempFixtures, test, assert, eq, waitUntil, waitForTabs, summary, sleep } from "./harness.mjs";

const fx = tempFixtures();
const shots = path.join(import.meta.dirname, "screenshots");

const svgReady = (page) =>
  waitUntil(() => page.evaluate(() => document.querySelector(".markdown-body pre.mermaid[data-processed] svg .node") !== null), {
    timeout: 15000,
    message: "diagram rendered",
  });

const mermaidLoaded = (page) =>
  page.evaluate(() => performance.getEntriesByType("resource").some((e) => /mermaid/.test(e.name)));

await test("renders diagrams, and only loads Mermaid when a document has one", async () => {
  const app = await launch({ args: [path.join(fx, "docs", "other.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await sleep(2000);
    eq(await mermaidLoaded(page), false, "no Mermaid for a document without diagrams");
  } finally {
    await app.close();
  }
  const app2 = await launch({ args: [path.join(fx, "docs", "sample.md")] });
  try {
    const page = await app2.page();
    await waitForTabs(page, 1);
    await svgReady(page);
    const labels = await page.evaluate(() => document.querySelector("pre.mermaid svg").textContent);
    assert(labels.includes("Start") && labels.includes("Choice"), `diagram labels: ${labels}`);
    assert(await mermaidLoaded(page), "Mermaid chunk loaded");
    await page.evaluate(() => document.querySelector("pre.mermaid").scrollIntoView());
    await page.screenshot({ path: path.join(shots, "mermaid-light.png") });
  } finally {
    await app2.close();
  }
});

await test("editing other text keeps the rendered diagram; editing the diagram redraws it", async () => {
  const file = path.join(fx, "docs", "sample.md");
  const app = await launch({ args: [file] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await svgReady(page);
    await page.evaluate(() => (document.querySelector("pre.mermaid svg").__marker = "same"));

    // Outside edit to a paragraph.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Intro paragraph", "Edited intro paragraph"));
    await waitUntil(() => page.evaluate(() => document.querySelector(".markdown-body").textContent.includes("Edited intro")), { message: "reload" });
    eq(await page.evaluate(() => document.querySelector("pre.mermaid svg")?.__marker), "same", "diagram SVG untouched");

    // Outside edit to the diagram itself.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("C[One]", "C[Uno]"));
    await waitUntil(
      () => page.evaluate(() => document.querySelector("pre.mermaid svg")?.textContent.includes("Uno")),
      { timeout: 15000, message: "diagram redrawn" },
    );
    eq(await page.evaluate(() => document.querySelector("pre.mermaid svg").__marker), undefined, "new SVG");
  } finally {
    await app.close();
  }
});

await test("a broken diagram shows an error without breaking the page", async () => {
  const file = path.join(fx, "docs", "broken.md");
  fs.writeFileSync(file, "# Broken\n\n```mermaid\ngraph LR\n  A --> \n  ((((\n```\n\nAfter the diagram.\n");
  const app = await launch({ args: [file] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await waitUntil(
      () => page.evaluate(() => {
        const n = document.querySelector("pre.mermaid");
        return n.classList.contains("mermaid-error") || n.hasAttribute("data-processed");
      }),
      { timeout: 15000, message: "diagram attempt finished" },
    );
    assert(await page.evaluate(() => document.querySelector(".markdown-body").textContent.includes("After the diagram.")), "rest of page intact");
  } finally {
    await app.close();
  }
});

await test("switching to dark mode redraws diagrams with the dark theme", async () => {
  const app = await launch({ args: [path.join(fx, "docs", "sample.md")], settings: { mode: "light" } });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await svgReady(page);
    const lightFill = await page.evaluate(() => getComputedStyle(document.querySelector("pre.mermaid svg .node rect, pre.mermaid svg .node polygon")).fill);
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("save_settings", { settings: { ...window.__MDV_BOOT__.settings, mode: "dark" } }));
    await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === "github-dark"), { message: "dark theme" });
    const darkFill = await waitUntil(async () => {
      const f = await page.evaluate(() => {
        const n = document.querySelector("pre.mermaid[data-processed] svg .node rect, pre.mermaid[data-processed] svg .node polygon");
        return n ? getComputedStyle(n).fill : null;
      });
      return f && f !== lightFill ? f : null;
    }, { timeout: 15000, message: "diagram re-themed" });
    console.log(`        node fill ${lightFill} -> ${darkFill}`);
    await page.evaluate(() => document.querySelector("pre.mermaid").scrollIntoView());
    await page.screenshot({ path: path.join(shots, "mermaid-dark.png") });
  } finally {
    await app.close();
  }
});

summary();
