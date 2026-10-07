// Measures real startup, open and memory numbers against a build of the app.
// Usage: node bench/startup.mjs [path to exe]   (defaults to the release build)
// Run `node bench/gen.mjs` first to create the test files.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXE = process.argv[2] ?? path.join(ROOT, "src-tauri", "target", "release", "md-viewer.exe");
const FILES = path.join(ROOT, "bench", "files");
const RUNS = Number(process.env.RUNS ?? 9);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [epoch, rel, ...label] = l.split(" ");
      return { epoch: Number(epoch), rel: Number(rel), label: label.join(" ") };
    });
}

async function waitFor(file, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = readLog(file).find((e) => e.label === label);
    if (hit) return hit;
    await sleep(5);
  }
  throw new Error(`timed out waiting for "${label}"`);
}

function kill(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

function start(args, log, cfg) {
  return spawn(EXE, args, { env: { ...process.env, MDV_PERF: log, MDV_CONFIG_DIR: cfg }, stdio: "ignore" });
}

/** Working set and private bytes of the app and its WebView2 processes. */
function memory(pid) {
  const ps = `
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize, PrivatePageCount
    $ids = New-Object System.Collections.Generic.HashSet[int]
    [void]$ids.Add(${pid})
    do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
    $mine = $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
    "{0} {1} {2}" -f $mine.Count, ($mine | Measure-Object WorkingSetSize -Sum).Sum, ($mine | Measure-Object PrivatePageCount -Sum).Sum`;
  const [count, ws, priv] = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(" ").map(Number);
  return { processes: count, workingSetMB: ws / 1048576, privateMB: priv / 1048576 };
}

async function launchOnce(file, { keep = false } = {}) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-bench-"));
  const log = path.join(cfg, "perf.log");
  const spawned = Date.now();
  const child = start(file ? [file] : [], log, cfg);
  const frame = await waitFor(log, "frontend: first frame");
  const events = readLog(log);
  const at = (label) => events.find((e) => e.label === label);
  const result = {
    // From launching the process to the first painted frame of the window.
    launchToPaint: frame.epoch - spawned,
    mainToShown: at("window shown")?.rel,
    mainToPaint: frame.rel,
    contentInserted: at("frontend: content inserted")?.rel,
  };
  if (keep) return { result, child, cfg, log };
  kill(child.pid);
  await sleep(400);
  return { result };
}

async function series(name, file) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push((await launchOnce(file)).result);
  const pick = (k) => median(runs.map((r) => r[k]).filter((v) => v !== undefined));
  console.log(
    `${name.padEnd(26)} launch->paint ${pick("launchToPaint").toFixed(0).padStart(4)} ms   ` +
      `main->shown ${pick("mainToShown").toFixed(0).padStart(4)} ms   main->paint ${pick("mainToPaint").toFixed(0).padStart(4)} ms`,
  );
}

console.log(`exe: ${EXE}\nruns per row: ${RUNS} (median)\n`);
await launchOnce(path.join(FILES, "readme-20k.md")); // warm the disk cache

await series("empty window", null);
await series("20 KB readme", path.join(FILES, "readme-20k.md"));
await series("1 MB document", path.join(FILES, "large-1mb.md"));
await series("280 KB code-heavy", path.join(FILES, "code-heavy-500k.md"));

// Opening a file while the app is running (second instance hands it over).
{
  const { child, cfg, log } = await launchOnce(path.join(FILES, "readme-20k.md"), { keep: true });
  await sleep(1500);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const copy = path.join(cfg, `copy-${i}.md`);
    fs.copyFileSync(path.join(FILES, "readme-20k.md"), copy);
    const before = readLog(log).filter((e) => e.label === "frontend: opened from os").length;
    const t0 = Date.now();
    const second = start([copy], path.join(cfg, "second.log"), cfg);
    const end = Date.now() + 10000;
    while (Date.now() < end && readLog(log).filter((e) => e.label === "frontend: opened from os").length === before) await sleep(2);
    const hit = readLog(log).filter((e) => e.label === "frontend: opened from os").at(-1);
    times.push(hit.epoch - t0);
    await new Promise((r) => (second.exitCode !== null ? r() : second.on("exit", r)));
  }
  console.log(`${"open in running app".padEnd(26)} launch->tab painted ${median(times).toFixed(0)} ms (20 KB file, new tab)`);

  await sleep(2000);
  const mem = memory(child.pid);
  console.log(
    `\nmemory with ${RUNS + 1} small tabs open: ${mem.processes} processes, ` +
      `working set ${mem.workingSetMB.toFixed(0)} MB, private ${mem.privateMB.toFixed(0)} MB`,
  );
  kill(child.pid);
  await sleep(400);
}

// Idle memory with a single small document.
{
  const { child } = await launchOnce(path.join(FILES, "readme-20k.md"), { keep: true });
  await sleep(3000);
  const mem = memory(child.pid);
  console.log(
    `memory, one 20 KB document: ${mem.processes} processes, working set ${mem.workingSetMB.toFixed(0)} MB, private ${mem.privateMB.toFixed(0)} MB`,
  );
  kill(child.pid);
}

const exeSize = fs.statSync(EXE).size / 1048576;
console.log(`\nexe size ${exeSize.toFixed(1)} MB`);
const nsis = path.join(path.dirname(EXE), "bundle", "nsis");
if (fs.existsSync(nsis)) {
  for (const f of fs.readdirSync(nsis).filter((f) => f.endsWith(".exe"))) {
    console.log(`installer ${f}: ${(fs.statSync(path.join(nsis, f)).size / 1048576).toFixed(1)} MB`);
  }
}
