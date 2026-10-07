// Runs every e2e suite in its own process. Build first with `npm run build:debug`
// (or set MDV_EXE to test another build).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = import.meta.dirname;
const only = process.argv[2];
const suites = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs") && (!only || f.includes(only)))
  .sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n${suite}`);
  const r = spawnSync(process.execPath, [path.join(dir, suite)], { stdio: "inherit", timeout: 600_000 });
  if (r.error) console.log(`  FAIL  ${suite} did not finish: ${r.error.message}`);
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nAll suites passed");
process.exitCode = failed ? 1 : 0;
