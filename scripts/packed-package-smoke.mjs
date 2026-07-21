/* global console, process */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const scratch = await mkdtemp(path.join(os.tmpdir(), "mission-control-package-smoke-"));

try {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", scratch], {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024
  });
  const packed = JSON.parse(stdout.trim());
  const archive = path.join(scratch, packed[0].filename);
  await execFileAsync("tar", ["-xzf", archive, "-C", scratch]);
  const packageRoot = path.join(scratch, "package");
  await execFileAsync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: packageRoot,
    maxBuffer: 10 * 1024 * 1024
  });
  process.env.HARNESS_PACKAGE_ROOT = packageRoot;

  const { ensureHarnessRepository } = await import(
    pathToFileURL(path.join(packageRoot, "src/core/bootstrap/repository.ts")).href
  );
  const { loadAllWorkflows } = await import(
    pathToFileURL(path.join(packageRoot, "src/core/workflows/cache.ts")).href
  );
  const { listSkills, readSkill } = await import(
    pathToFileURL(path.join(packageRoot, "src/core/catalog/skills-catalog.ts")).href
  );
  const { loadEvalCorpus } = await import(
    pathToFileURL(path.join(packageRoot, "src/core/evals/load.ts")).href
  );

  const runtimeRoot = path.join(scratch, "runtime");
  await ensureHarnessRepository(runtimeRoot);
  const workflows = await loadAllWorkflows(runtimeRoot);
  const skills = await listSkills(runtimeRoot);
  for (const skill of skills) await readSkill(runtimeRoot, skill.name);
  const corpus = await loadEvalCorpus();
  if (workflows.size === 0 || skills.length === 0 || corpus.cases.length === 0) {
    throw new Error("Packed artifact did not seed workflows, skills, and evaluation cases.");
  }
  await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    path.join(packageRoot, "scripts/baseline-report.mjs"),
    "--root",
    runtimeRoot,
    "--out",
    path.join(scratch, "baseline-out")
  ], { cwd: packageRoot, env: { ...process.env, HARNESS_PACKAGE_ROOT: packageRoot }, maxBuffer: 20 * 1024 * 1024 });
  console.log(`Packed artifact smoke passed: ${workflows.size} workflows, ${skills.length} skills, ${corpus.cases.length} eval cases, baseline command.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
