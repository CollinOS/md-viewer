// End-to-end test harness. Launches the real app with WebView2's remote
// debugging port open and drives it with Playwright over CDP.

import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const FIXTURES = path.join(ROOT, "e2e", "fixtures");
export const EXE = process.env.MDV_EXE ?? path.join(ROOT, "src-tauri", "target", "debug", "md-viewer.exe");

let nextPort = 9400 + Math.floor(Math.random() * 400);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copies the fixtures to a temp folder so tests can modify files freely. */
export function tempFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-fx-"));
  fs.cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

export async function waitUntil(fn, { timeout = 10000, interval = 50, message = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message} (last: ${last})`);
}

export async function launch({ args = [], configDir, settings, env = {} } = {}) {
  configDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "mdv-cfg-"));
  if (settings) fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings));
  const perfLog = path.join(configDir, "perf.log");
  const port = nextPort++;
  const child = spawn(EXE, args, {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      MDV_CONFIG_DIR: configDir,
      MDV_PERF: perfLog,
      ...env,
    },
    stdio: "ignore",
  });
  const browser = await waitUntil(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`), {
    timeout: 20000,
    interval: 100,
    message: "CDP connection",
  });

  const app = {
    child,
    browser,
    configDir,
    perfLog,
    /** All app pages (one per window), oldest first. */
    async pages() {
      const all = browser.contexts().flatMap((c) => c.pages());
      const ready = [];
      for (const p of all) {
        if (await p.evaluate(() => !!window.__mdv?.ready).catch(() => false)) ready.push(p);
      }
      return ready;
    },
    async page(index = 0) {
      return waitUntil(async () => (await app.pages())[index], { message: `window ${index}` });
    },
    async waitForWindows(n) {
      return waitUntil(async () => ((await app.pages()).length === n ? app.pages() : null), { message: `${n} windows` });
    },
    perf() {
      return fs.existsSync(perfLog) ? fs.readFileSync(perfLog, "utf8") : "";
    },
    async close() {
      await browser.close().catch(() => {});
      killTree(child.pid);
      await waitUntil(() => child.exitCode !== null || child.signalCode !== null, { timeout: 5000, message: "exit" }).catch(() => {});
      // Give the single-instance lock time to release before the next launch.
      await sleep(300);
    },
  };
  return app;
}

export const tabs = (page) => page.evaluate(() => window.__mdv.tabs());

export async function waitForTabs(page, n) {
  return waitUntil(async () => {
    const t = await tabs(page);
    return t.length === n ? t : null;
  }, { message: `${n} tabs` });
}

// ---------- Tiny test runner ----------

const results = [];

export async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 4).join("\n        ")}`);
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

export function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}
