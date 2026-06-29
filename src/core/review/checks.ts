import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { runShell } from "../worktrees/worktrees.ts";

/** Canonical check kinds the planner probes for during detection. */
export type CheckKind = "lint" | "test" | "typecheck";

const CHECK_KINDS: ReadonlyArray<{ kind: CheckKind; names: readonly string[] }> = [
  { kind: "lint", names: ["lint"] },
  { kind: "test", names: ["test"] },
  { kind: "typecheck", names: ["typecheck", "type-check"] }
];

export interface CheckSpec {
  name: string;
  command: string;
  /** Fail-fast: stop running further checks once this one fails. Default: false. */
  fatal?: boolean;
}

/** A check resolved by the planner: either runnable or explicitly unavailable. */
export interface PlannedCheck {
  name: string;
  kind?: CheckKind;
  command: string;
  available: boolean;
  /**
   * Working directory for the command, relative to the workspace root (absolute
   * paths are used as-is). Absent means run at the workspace root.
   */
  cwd?: string;
  /** Present when `available` is false; explains why the tooling is missing. */
  skipReason?: string;
  fatal?: boolean;
}

export type CheckPlanSource =
  | "checks.yml"
  | "quality-gate"
  | "package.json"
  | "makefile"
  | "hybrid"
  | "none";

export interface CheckPlan {
  checks: PlannedCheck[];
  maxRounds: number;
  source: CheckPlanSource;
  /**
   * Present when the plan deliberately runs no blocking checks because the
   * project's generated gate is not actionable (`incomplete`/`failed`): a
   * human-readable note naming what the operator must resolve. Rendered in the
   * author prompt and the checks-outcome message so the gap is never mistaken for
   * an ordinary no-checks run. Absent for workspace-local detection.
   */
  resolutionNote?: string;
}

export type CheckResultStatus = "passed" | "failed" | "skipped";

export interface CheckRunResult {
  name: string;
  command: string;
  status: CheckResultStatus;
  exitCode: number;
  output: string;
  /** Present when `status === "skipped"`. */
  skipReason?: string;
}

export type CheckOutcome = "validated" | "failed" | "noChecks";

export interface CheckSummary {
  /**
   * `validated`: at least one check ran and all passed.
   * `failed`: at least one check ran and one failed.
   * `noChecks`: nothing ran (no tooling detected or every check unavailable).
   */
  outcome: CheckOutcome;
  /** True when `outcome !== "failed"` (validated or noChecks). Gate callers treat this as ok. */
  pass: boolean;
  /** True when `outcome === "noChecks"`. Distinct from a validated pass. */
  skipped: boolean;
  /** Where the plan came from. */
  source: CheckPlanSource;
  /** Per-check outcomes in order. */
  results: CheckRunResult[];
  /** Cap on how many remediation rounds the processor should attempt. */
  maxRounds: number;
  /** Mirrors {@link CheckPlan.resolutionNote} so the outcome message can surface it. */
  resolutionNote?: string;
}

const MAX_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_CHECK_REMEDIATION_ROUNDS = 3;

function clipOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return `${output.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]`;
}

interface ParsedConfig {
  checks: CheckSpec[];
  maxRounds: number;
}

/** Parse `.harness/checks.yml` via the shared YAML dependency. */
function parseChecksFile(text: string): ParsedConfig {
  const raw = parseYaml(text);
  const checks: CheckSpec[] = [];
  let maxRounds = DEFAULT_CHECK_REMEDIATION_ROUNDS;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { checks, maxRounds };
  }

  const doc = raw as Record<string, unknown>;
  if (Array.isArray(doc["checks"])) {
    for (const item of doc["checks"]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
      const command = typeof entry["command"] === "string" ? entry["command"].trim() : "";
      if (!name || !command) continue;
      checks.push({
        name,
        command,
        fatal: entry["fatal"] === true
      });
    }
  }

  if (typeof doc["maxRounds"] === "number" && Number.isFinite(doc["maxRounds"]) && doc["maxRounds"] > 0) {
    maxRounds = Math.floor(doc["maxRounds"]);
  }

  return { checks, maxRounds };
}

async function loadChecksFile(workspacePath: string): Promise<ParsedConfig | null> {
  const candidate = path.join(workspacePath, ".harness", "checks.yml");
  try {
    const text = await readFile(candidate, "utf8");
    const parsed = parseChecksFile(text);
    if (!parsed.checks.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingFile(workspacePath: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const filePath = path.join(workspacePath, candidate);
    if (await pathExists(filePath)) return filePath;
  }
  return null;
}

type PackageManager = "npm" | "yarn" | "pnpm";

async function detectPackageManager(workspacePath: string): Promise<PackageManager> {
  if (await pathExists(path.join(workspacePath, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(workspacePath, "yarn.lock"))) return "yarn";
  return "npm";
}

function packageManagerRunPrefix(pm: PackageManager): string {
  if (pm === "yarn") return "yarn run";
  if (pm === "pnpm") return "pnpm run";
  return "npm run -s";
}

/**
 * Detect checks from a project's `package.json` `scripts`. Detection honours the
 * package's declared scripts and the lockfile-selected package manager rather
 * than assuming a specific toolchain.
 */
async function detectPackageJsonChecks(workspacePath: string): Promise<PlannedCheck[] | null> {
  const pkgPath = path.join(workspacePath, "package.json");
  const raw = await readFile(pkgPath, "utf8").catch(() => null);
  if (raw === null) return null;

  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
      scripts = pkg.scripts as Record<string, unknown>;
    }
  } catch {
    // Malformed package.json: fall through with no scripts detected.
  }

  const pm = await detectPackageManager(workspacePath);
  const runPrefix = packageManagerRunPrefix(pm);

  return CHECK_KINDS.map(({ kind, names }) => {
    const declared = names.find((name) => typeof scripts[name] === "string" && (scripts[name] as string).length > 0);
    if (declared) {
      return { name: kind, kind, command: `${runPrefix} ${declared}`, available: true };
    }
    return {
      name: kind,
      kind,
      command: `${runPrefix} ${names[0]}`,
      available: false,
      skipReason: `no ${names.join("/")} script declared in package.json`
    };
  });
}

/** Detect checks from `Makefile` targets. */
async function detectMakefileChecks(workspacePath: string): Promise<PlannedCheck[] | null> {
  const makePath = await firstExistingFile(workspacePath, ["Makefile", "makefile", "GNUmakefile"]);
  if (!makePath) return null;

  const text = await readFile(makePath, "utf8").catch(() => "");
  const targets = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-zA-Z0-9_.-]+)\s*:/);
    if (match && match[1]) targets.add(match[1]);
  }

  return CHECK_KINDS.map(({ kind, names }) => {
    const declared = names.find((name) => targets.has(name));
    if (declared) {
      return { name: kind, kind, command: `make ${declared}`, available: true };
    }
    return {
      name: kind,
      kind,
      command: `make ${names[0]}`,
      available: false,
      skipReason: `no ${names.join("/")} target declared in Makefile`
    };
  });
}

/**
 * Merge per-kind detections so a kind unavailable in one source can still be
 * satisfied by another. A declared `package.json` script wins for its kind;
 * otherwise a `Makefile` target fills the gap. A kind unavailable everywhere it
 * was probed keeps an explicit skip reason naming every source that was checked.
 */
function mergeDetectedChecks(
  packageChecks: PlannedCheck[] | null,
  makeChecks: PlannedCheck[] | null
): PlannedCheck[] {
  return CHECK_KINDS.map(({ kind }) => {
    const pkg = packageChecks?.find((check) => check.kind === kind);
    const make = makeChecks?.find((check) => check.kind === kind);
    if (pkg?.available) return pkg;
    if (make?.available) return make;

    const reasons: string[] = [];
    if (packageChecks && pkg?.skipReason) reasons.push(pkg.skipReason);
    if (makeChecks && make?.skipReason) reasons.push(make.skipReason);
    return {
      name: kind,
      kind,
      command: (pkg ?? make)?.command ?? kind,
      available: false,
      ...(reasons.length ? { skipReason: reasons.join(" and ") } : {})
    };
  });
}

/**
 * Resolve the check plan for a workspace. Explicit `.harness/checks.yml` wins;
 * otherwise each canonical kind is detected from `package.json` scripts (package
 * manager inferred from the lockfile) and `Makefile` targets, merged per kind so
 * a script missing from one file can be satisfied by a target in the other.
 * Detection never infers commands from a toolchain's mere presence, only from
 * what the project explicitly declares.
 */
export async function planChecks(workspacePath: string): Promise<CheckPlan> {
  const fileConfig = await loadChecksFile(workspacePath);
  if (fileConfig) {
    return {
      checks: fileConfig.checks.map((spec) => ({
        name: spec.name,
        command: spec.command,
        available: true,
        ...(spec.fatal ? { fatal: spec.fatal } : {})
      })),
      maxRounds: fileConfig.maxRounds,
      source: "checks.yml"
    };
  }

  const packageChecks = await detectPackageJsonChecks(workspacePath);
  const makeChecks = await detectMakefileChecks(workspacePath);
  if (!packageChecks && !makeChecks) {
    return { checks: [], maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS, source: "none" };
  }

  const source: CheckPlanSource =
    packageChecks && makeChecks ? "hybrid" : packageChecks ? "package.json" : "makefile";
  return {
    checks: mergeDetectedChecks(packageChecks, makeChecks),
    maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
    source
  };
}

function parseCommand(command: string): { cmd: string | null; args: string[] } {
  const argv = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cmd = argv.shift();
  const args = argv.map((arg) => arg.replace(/^['"]|['"]$/g, ""));
  return { cmd: cmd ?? null, args };
}

/**
 * Execute a resolved check plan against `workspacePath`. Unavailable checks are
 * recorded as explicit skips (never a silent pass). A plan with no runnable
 * checks returns `outcome: "noChecks"` rather than pretending to pass. Extracted
 * so both the workspace-local and project-scoped runners share one execution path.
 */
export async function runCheckPlan(
  plan: CheckPlan,
  workspacePath: string,
  onChunk?: (chunk: string) => void
): Promise<CheckSummary> {
  const results: CheckRunResult[] = [];

  for (const spec of plan.checks) {
    if (!spec.available) {
      results.push({
        name: spec.name,
        command: spec.command,
        status: "skipped",
        exitCode: 0,
        output: "",
        ...(spec.skipReason ? { skipReason: spec.skipReason } : {})
      });
      continue;
    }

    const { cmd, args } = parseCommand(spec.command);
    if (!cmd) continue;
    const runCwd = spec.cwd ? path.resolve(workspacePath, spec.cwd) : workspacePath;
    onChunk?.(`\n[check] ${spec.name}: ${spec.command}\n`);
    const { exitCode, output } = await runShell(cmd, args, runCwd, onChunk);
    results.push({
      name: spec.name,
      command: spec.command,
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
      output: clipOutput(output)
    });
    if (exitCode !== 0 && spec.fatal) break;
  }

  const executed = results.filter((result) => result.status !== "skipped");
  const failed = results.some((result) => result.status === "failed");
  const outcome: CheckOutcome = executed.length === 0 ? "noChecks" : failed ? "failed" : "validated";

  return {
    outcome,
    pass: outcome !== "failed",
    skipped: outcome === "noChecks",
    source: plan.source,
    results,
    maxRounds: plan.maxRounds,
    ...(plan.resolutionNote ? { resolutionNote: plan.resolutionNote } : {})
  };
}

/**
 * Run the planned checks for `workspacePath`. Unavailable checks are recorded as
 * explicit skips (never a silent pass). A workspace with no runnable checks
 * returns `outcome: "noChecks"` rather than pretending to pass.
 */
export async function runChecks(
  workspacePath: string,
  onChunk?: (chunk: string) => void
): Promise<CheckSummary> {
  return runCheckPlan(await planChecks(workspacePath), workspacePath, onChunk);
}

export function summarizeFailures(summary: CheckSummary): string {
  const failed = summary.results.filter((result) => result.status === "failed");
  if (!failed.length) return "";
  return failed
    .map((result) => `### ${result.name}\nExit code: ${result.exitCode}\nCommand: ${result.command}\n\n${result.output.trim()}`)
    .join("\n\n---\n\n");
}

function describeNoChecksSource(source: CheckPlanSource): string {
  switch (source) {
    case "checks.yml":
      return "`.harness/checks.yml` declared no checks";
    case "quality-gate":
      return "the generated quality-gate config declared no required checks";
    case "package.json":
      return "`package.json` declared no lint/test/typecheck scripts";
    case "makefile":
      return "the `Makefile` declared no lint/test/typecheck targets";
    case "hybrid":
      return "neither `package.json` scripts nor the `Makefile` declared any lint/test/typecheck commands";
    default:
      return "no `.harness/checks.yml`, `package.json`, or `Makefile` was found";
  }
}

export function describeChecksOutcome(summary: CheckSummary): string {
  if (summary.outcome === "noChecks") {
    if (summary.resolutionNote) {
      // An incomplete/failed gate ran nothing because the operator must resolve it
      // first; surface that reason rather than the generic detection line.
      return `${summary.resolutionNote} Nothing was validated.`;
    }
    return `No mechanical checks detected for this project (${describeNoChecksSource(summary.source)}). Nothing was validated.`;
  }

  const skipped = summary.results.filter((result) => result.status === "skipped");
  const skippedNote = skipped.length
    ? ` Skipped (tooling unavailable): ${skipped.map((result) => `${result.name}: ${result.skipReason}`).join("; ")}.`
    : "";

  if (summary.outcome === "validated") {
    const names = summary.results.filter((result) => result.status === "passed").map((result) => result.name).join(", ");
    return `Mechanical checks passed${names ? ` (${names})` : ""}.${skippedNote}`;
  }

  const failedCount = summary.results.filter((result) => result.status === "failed").length;
  return `Mechanical checks failed (${failedCount} of ${summary.results.length}).${skippedNote}`;
}

export async function resolveCheckMaxRounds(workspacePath: string): Promise<number> {
  const plan = await planChecks(workspacePath);
  return plan.maxRounds;
}

/**
 * Render a check plan for an implementation prompt so the author agent runs the
 * exact commands the harness gate will run (single source of truth for which
 * commands exist), and can see which checks are unavailable rather than guessing.
 */
export function describeCheckPlan(plan: CheckPlan): string {
  const available = plan.checks.filter((check) => check.available);
  const unavailable = plan.checks.filter((check) => !check.available);

  if (available.length === 0) {
    if (plan.resolutionNote) {
      // An incomplete/failed gate: tell the author the operator action that is
      // blocking the automated gate, so the gap is visible in the prompt rather
      // than reading as an ordinary empty repo.
      return `## Detected mechanical checks

${plan.resolutionNote} The harness runs no automated gate for this project until this is resolved; run whatever validation makes sense by hand before you finish.`;
    }
    const note = unavailable.length
      ? `None of the probed checks are available: ${unavailable
          .map((check) => `${check.name} (${check.skipReason ?? "unavailable"})`)
          .join("; ")}.`
      : "No `.harness/checks.yml`, `package.json` scripts, or `Makefile` targets were detected.";
    return `## Detected mechanical checks

${note} The harness will not run an automated gate for this project. Run whatever validation makes sense by hand before you finish.`;
  }

  // Mirror runCheckPlan: when a check carries a cwd the gate runs it from that
  // subdirectory, so the author-facing command must `cd` there too. Otherwise the
  // rendered command would pass or fail differently than the enforced gate.
  const lines = available.map((check) => {
    const command = check.cwd ? `cd ${check.cwd} && ${check.command}` : check.command;
    return `- \`${command}\``;
  });
  const skipLines = unavailable.length
    ? `\n\nUnavailable (do not invent substitutes): ${unavailable
        .map((check) => `${check.name}: ${check.skipReason ?? "unavailable"}`)
        .join("; ")}.`
    : "";

  return `## Detected mechanical checks

The harness re-runs these exact commands after your turn and blocks on failure, so run them yourself first and fix what they report:

${lines.join("\n")}${skipLines}`;
}

export function buildCheckRemediationPrompt(checkSummary: string, round: number): string {
  return `Mechanical checks failed (attempt ${round}). Fix the issues described below.

${checkSummary}

When the fix is ready, end your turn. The harness will re-run the checks immediately.`;
}
