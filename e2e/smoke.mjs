// Platform-neutral smoke test: launches the app on the sample document and
// reads the self-check line it logs when MDV_PERF is set. Used on Linux in CI,
// where the Playwright suites (which need WebView2) can't run.
// Usage: node e2e/smoke.mjs <path to app binary>

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exe = process.argv[2];
if (!exe) throw new Error("usage: node e2e/smoke.mjs <app binary>");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-smoke-"));
fs.cpSync(path.join(import.meta.dirname, "fixtures"), path.join(work, "fixtures"), { recursive: true });
const log = path.join(work, "perf.log");
const doc = path.join(work, "fixtures", "docs", "sample.md");

const child = spawn(exe, [doc], {
  env: { ...process.env, MDV_PERF: log, MDV_CONFIG_DIR: work },
  stdio: "inherit",
});

const deadline = Date.now() + 60_000;
let line;
while (Date.now() < deadline && child.exitCode === null) {
  const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  line = text.split("\n").find((l) => l.includes("selfcheck"));
  if (line) break;
  await new Promise((r) => setTimeout(r, 200));
}
child.kill();

const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "(no log written)";
console.log(text);
const failures = [];
if (!line) {
  failures.push("the app never logged its self-check");
} else {
  const get = (key) => line.match(new RegExp(`${key}=(\\S+)`))?.[1];
  const [loaded, total] = (get("images") ?? "0/0").split("/").map(Number);
  // sample.md has four images that should load, plus two that must not
  // (a non-media file and a broken raw <img>).
  if (total !== 6 || loaded !== 4) failures.push(`expected 4/6 images loaded, got ${loaded}/${total}`);
  if (Number(get("tabs")) !== 1) failures.push(`expected 1 tab, got ${get("tabs")}`);
  if (!(Number(get("tokens")) > 5)) failures.push(`code wasn't highlighted (tokens=${get("tokens")})`);
  if (Number(get("diagrams")) !== 1) failures.push(`expected 1 rendered diagram, got ${get("diagrams")}`);
}
if (failures.length) {
  console.error(`Smoke test failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Smoke test passed");
