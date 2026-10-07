// Phase 1: opening and rendering documents.

import path from "node:path";
import { launch, tempFixtures, test, assert, eq, waitUntil, waitForTabs, summary, sleep } from "./harness.mjs";

const fx = tempFixtures();
const sample = path.join(fx, "docs", "sample.md");
const shots = path.join(import.meta.dirname, "screenshots");

await test("opens a file from the command line and renders GFM", async () => {
  const app = await launch({ args: [sample] });
  try {
    const page = await app.page();
    const t = await waitForTabs(page, 1);
    eq(t[0].name, "sample.md", "tab name");
    assert(t[0].active, "tab is active");
    const r = await page.evaluate(() => {
      const a = document.querySelector(".markdown-body");
      return {
        h1: a.querySelector("h1#sample-document")?.textContent,
        frontMatter: a.textContent.includes("front matter should not show"),
        table: a.querySelectorAll("table tr").length,
        tasks: a.querySelectorAll(".task-list-item input[type=checkbox]").length,
        checked: a.querySelectorAll(".task-list-item input:checked").length,
        del: !!a.querySelector("del"),
        autolink: !!a.querySelector('a[href="https://example.com"]'),
        alerts: a.querySelectorAll(".markdown-alert").length,
        footnote: !!a.querySelector(".footnotes"),
        details: !!a.querySelector("details summary"),
        title: document.title,
      };
    });
    eq(r.h1, "Sample Document", "h1 with id");
    eq(r.frontMatter, false, "front matter hidden");
    eq(r.table, 3, "table rows");
    eq(r.tasks, 2, "task checkboxes");
    eq(r.checked, 1, "checked tasks");
    assert(r.del && r.autolink && r.footnote && r.details, "inline features");
    eq(r.alerts, 2, "alerts");
    eq(r.title, "sample.md - MD Viewer", "window title");
  } finally {
    await app.close();
  }
});

await test("highlights code with theme classes", async () => {
  const app = await launch({ args: [sample] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    const r = await page.evaluate(() => {
      const rust = document.querySelector("code.language-rust");
      const ts = document.querySelector("code.language-typescript");
      const kw = rust.querySelector("hl-k");
      return {
        rustSpans: rust.querySelectorAll("hl-k, hl-s, hl-f, hl-t, hl-n, hl-c").length,
        tsSpans: ts.querySelectorAll("hl-k, hl-s, hl-f, hl-t, hl-n, hl-c").length,
        kwColor: getComputedStyle(kw).color,
        bodyColor: getComputedStyle(rust).color,
        inline: !!rust.querySelector("[style]"),
      };
    });
    assert(r.rustSpans > 5, `rust highlighted (${r.rustSpans})`);
    assert(r.tsSpans > 5, `typescript highlighted (${r.tsSpans})`);
    assert(r.kwColor !== r.bodyColor, "keyword has its own color");
    eq(r.inline, false, "no inline styles");
  } finally {
    await app.close();
  }
});

await test("loads local images through mdfile:// and refuses non-media", async () => {
  const app = await launch({ args: [sample] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    const imgs = await waitUntil(
      () =>
        page.evaluate(() => {
          const list = [...document.querySelectorAll(".markdown-body img")].map((i) => ({
            alt: i.alt,
            src: i.getAttribute("src"),
            loaded: i.complete && i.naturalWidth > 0,
            done: i.complete,
          }));
          return list.every((i) => i.done) ? list : null;
        }),
      { message: "images to finish loading" },
    );
    const by = Object.fromEntries(imgs.map((i) => [i.alt, i]));
    assert(by.blue.src.startsWith("http://mdfile.localhost/"), `rewritten src ${by.blue.src}`);
    assert(by.blue.loaded, "relative png loads");
    assert(by.parent.loaded, "../ path with encoded space loads");
    assert(by.svg.loaded, "svg loads");
    assert(by["raw html image"].loaded, "raw <img> tag loads");
    eq(by["not media"].loaded, false, "non-media file is refused");
    await page.screenshot({ path: path.join(shots, "viewer-light.png") });
  } finally {
    await app.close();
  }
});

await test("strips scripts, styles and inline handlers from raw HTML", async () => {
  const app = await launch({ args: [sample] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);
    await sleep(500);
    const r = await page.evaluate(() => ({
      pwned: !!window.__pwned || !!window.__pwned2,
      script: !!document.querySelector(".markdown-body script"),
      style: [...document.querySelectorAll(".markdown-body style")].some((s) => !s.closest("svg")),
      bodyVisible: getComputedStyle(document.body).display !== "none",
    }));
    eq(r, { pwned: false, script: false, style: false, bodyVisible: true }, "sanitized");
  } finally {
    await app.close();
  }
});

await test("links: anchors scroll, .md links open tabs, missing links report errors", async () => {
  const app = await launch({ args: [sample] });
  try {
    const page = await app.page();
    await waitForTabs(page, 1);

    await page.click('a[href="#tasks"]');
    await waitUntil(() => page.evaluate(() => document.querySelector(".preview-pane").scrollTop > 100), { message: "anchor scroll" });

    await page.click('a[href="other.md#second-section"]');
    const t = await waitForTabs(page, 2);
    eq(t[1].name, "other.md", "linked doc opened");
    assert(t[1].active, "linked doc active");
    await waitUntil(
      () =>
        page.evaluate(() => {
          const h = document.querySelector(".markdown-body h2#second-section");
          return h && h.getBoundingClientRect().top < 120;
        }),
      { message: "scrolled to fragment in new tab" },
    );

    // Clicking a link to an already open doc switches to it instead of duplicating.
    await page.keyboard.press("Control+1");
    await page.click('a[href="other.md"]');
    await sleep(300);
    const t2 = await waitForTabs(page, 2);
    assert(t2[1].active, "existing tab activated");

    await page.keyboard.press("Control+1");
    await page.click('a[href="nope.md"]');
    await waitUntil(() => page.evaluate(() => document.querySelector(".toast.error")?.textContent), { message: "error toast" });
  } finally {
    await app.close();
  }
});

await test("starts with an empty state when no file is given", async () => {
  const app = await launch();
  try {
    const page = await app.page();
    const r = await page.evaluate(() => ({
      empty: !document.querySelector(".empty-state").hidden,
      tabs: window.__mdv.tabs().length,
      editDisabled: document.querySelector('[data-action="edit"]').disabled,
    }));
    eq(r, { empty: true, tabs: 0, editDisabled: true }, "empty state");
  } finally {
    await app.close();
  }
});

await test("reports files that can't be opened", async () => {
  const app = await launch({ args: [path.join(fx, "docs", "does-not-exist.md"), path.join(fx, "docs")] });
  try {
    const page = await app.page();
    const n = await waitUntil(() => page.evaluate(() => document.querySelectorAll(".toast.error").length >= 2 && document.querySelectorAll(".toast.error").length), {
      message: "two error toasts",
    });
    eq(n, 2, "error toasts");
  } finally {
    await app.close();
  }
});

await test("decodes UTF-16 and CRLF files", async () => {
  const app = await launch({ args: [path.join(fx, "docs", "utf16.md"), path.join(fx, "docs", "crlf.md")] });
  try {
    const page = await app.page();
    await waitForTabs(page, 2);
    const text = await page.evaluate(() => document.querySelector(".markdown-body").textContent);
    assert(text.includes("Café naïve"), `utf-16 text decoded: ${text}`);
  } finally {
    await app.close();
  }
});

summary();
