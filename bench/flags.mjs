// Compares WebView2 browser flags for startup time and memory, using the
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS override (no rebuild needed).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "md-viewer.exe");
const FILE = path.join(ROOT, "bench", "files", "readme-20k.md");
const BASE = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const sets = {
  baseline: BASE,
  "no spare renderer": `${BASE},SpareRendererForSitePerProcess`,
  "in-process gpu": `${BASE} --in-process-gpu`,
  "both": `${BASE},SpareRendererForSitePerProcess --in-process-gpu`,
  "both + no bg networking": `${BASE},SpareRendererForSitePerProcess --in-process-gpu --disable-background-networking --disable-component-update`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function memory(pid) {
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, PrivatePageCount
    $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add(${pid})
    do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
    $m = $all | Where-Object { $ids.Contains([int]$_.ProcessId) }; "{0} {1}" -f $m.Count, ($m | Measure-Object PrivatePageCount -Sum).Sum`;
  const [n, priv] = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(" ").map(Number);
  return { n, mb: priv / 1048576 };
}

async function run(args, measureMem) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-fl-"));
  const log = path.join(dir, "perf.log");
  const t0 = Date.now();
  const child = spawn(EXE, [FILE], { env: { ...process.env, MDV_PERF: log, MDV_CONFIG_DIR: dir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args }, stdio: "ignore" });
  while (!(fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("first frame"))) await sleep(5);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
  const get = (label) => lines.find((l) => l.slice(2).join(" ") === label);
  const r = { built: Number(get("window built")[1]), paint: Number(get("frontend: first frame")[0]) - t0 };
  if (measureMem) {
    await sleep(3000);
    r.mem = memory(child.pid);
  }
  execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(500);
  return r;
}

await run(BASE, false);
for (const [name, args] of Object.entries(sets)) {
  const rs = [];
  for (let i = 0; i < 7; i++) rs.push(await run(args, i === 0));
  const mem = rs[0].mem;
  console.log(`${name.padEnd(26)} window built ${median(rs.map((r) => r.built)).toFixed(0).padStart(4)} ms  launch->paint ${median(rs.map((r) => r.paint)).toFixed(0).padStart(4)} ms  ${mem.n} procs  ${mem.mb.toFixed(0)} MB private`);
}
