// Prints the perf log of one launch so you can see where startup time goes.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXE = process.env.MDV_EXE ?? path.join(ROOT, "src-tauri", "target", "release", "md-viewer.exe");
const file = process.argv[2] ?? path.join(ROOT, "bench", "files", "readme-20k.md");

for (let run = 0; run < 3; run++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-bd-"));
  const log = path.join(dir, "perf.log");
  const t0 = Date.now();
  const child = spawn(EXE, [file], { env: { ...process.env, MDV_PERF: log, MDV_CONFIG_DIR: dir }, stdio: "ignore" });
  while (!(fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("first frame"))) await new Promise((r) => setTimeout(r, 5));
  execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
  if (run < 2) continue;
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  const first = Number(lines[0].split(" ")[0]);
  console.log(`process spawn -> main(): ~${first - t0 - Number(lines[0].split(" ")[1])} ms`);
  for (const l of lines) {
    const [, rel, ...label] = l.split(" ");
    console.log(`${rel.padStart(8)} ms  ${label.join(" ")}`);
  }
}
