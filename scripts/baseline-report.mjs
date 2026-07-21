/**
 * Generate a reproducible baseline report for workflow-agent optimization Phase 0.
 *
 * Usage:
 *   node --experimental-strip-types --experimental-transform-types --disable-warning=ExperimentalWarning scripts/baseline-report.mjs [--root <harnessRoot>] [--out <dir>]
 */
/* global process, console */
import path from "node:path";

import { DEFAULT_HARNESS_ROOT } from "../src/core/bootstrap/repository.ts";
import { loadEvalCorpus } from "../src/core/evals/index.ts";
import { buildBaselineReport, writeBaselineReport } from "../src/core/baseline/index.ts";
import { collectRuntimeInventory } from "../src/core/inventory/index.ts";

const args = process.argv.slice(2);
let root = process.env["HARNESS_ROOT"]?.trim() || DEFAULT_HARNESS_ROOT;
let outDir = path.join(process.cwd(), "tmp");

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--root") {
    root = path.resolve(args[index + 1] ?? "");
    index += 1;
    continue;
  }
  if (arg === "--out") {
    outDir = path.resolve(args[index + 1] ?? "");
    index += 1;
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    console.log("Usage: node scripts/baseline-report.mjs [--root <harnessRoot>] [--out <dir>]");
    process.exit(0);
  }
  throw new Error(`Unknown argument: ${arg}`);
}

const [inventory, corpus] = await Promise.all([collectRuntimeInventory(root), loadEvalCorpus()]);
const report = await buildBaselineReport({
  root,
  inventory,
  corpus,
  command: `node scripts/baseline-report.mjs --root ${root}`
});
const paths = await writeBaselineReport(report, outDir);
console.log(`Baseline ${report.baselineId}`);
console.log(`Wrote ${paths.jsonPath}`);
console.log(`Wrote ${paths.markdownPath}`);
