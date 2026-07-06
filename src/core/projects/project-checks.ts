import {
  DEFAULT_CHECK_REMEDIATION_ROUNDS,
  planChecks,
  runCheckPlan,
  type CheckKind,
  type CheckPlan,
  type CheckSummary,
  type PlannedCheck
} from "../review/checks.ts";
import {
  findUnsupportedShellSyntax,
  isMutatingCommand,
  isRepoRelativePath,
  isVerificationCategory,
  readProjectQualityGate,
  type QualityGateCheck,
  type QualityGateFile
} from "./quality-gate.ts";

/** Map a generated quality-gate category onto a canonical check kind, if any. */
function gateCategoryToKind(category: QualityGateCheck["category"]): CheckKind | undefined {
  if (category === "lint" || category === "test" || category === "typecheck") return category;
  return undefined;
}

/**
 * Build the operator-facing note for a gate that cannot drive the gate as-is.
 * Covers `generating` (turn in flight), the `needsResolution` gaps
 * (`incomplete`), or the `error` (`failed`), carrying each through the check
 * plan so they reach the author prompt and checks-outcome message instead of
 * collapsing to an ordinary no-checks run.
 */
function describeGateResolution(gate: QualityGateFile): string {
  if (gate.status === "generating") {
    return "The project's quality gate is still being generated; it has not produced checks yet.";
  }
  if (gate.status === "incomplete") {
    const gaps = (gate.needsResolution ?? []).map((gap) => gap.trim()).filter((gap) => gap.length > 0);
    const detail =
      gaps.length > 0
        ? gaps.join(" ")
        : "the operator must document how to lint, test, and build this repo.";
    return `The project's quality gate is incomplete and needs operator resolution: ${detail}`;
  }
  // status === "failed"
  const reason = (gate.error ?? "").trim() || "generation could not gather project intel";
  return `The project's quality gate generation failed (${reason}); the operator must resolve this.`;
}

function gateCheckToPlanned(check: QualityGateCheck): PlannedCheck {
  const planned: PlannedCheck = {
    name: check.name,
    command: check.command,
    available: true
  };
  const kind = gateCategoryToKind(check.category);
  if (kind) planned.kind = kind;
  // Stored configs are re-read with only a loose shape check, so the containment
  // guard is enforced here too: an unsafe cwd never reaches the executor or the
  // rendered author prompt.
  if (check.workingDirectory && isRepoRelativePath(check.workingDirectory)) planned.cwd = check.workingDirectory;
  // Same reason, same boundary: a command the direct-spawn executor cannot run
  // (shell operators, a leading env assignment) becomes an explicit skip with a
  // reason, instead of being spawned and silently mis-running its first stage.
  const shellSyntax = findUnsupportedShellSyntax(check.command);
  if (shellSyntax !== null) {
    planned.available = false;
    planned.skipReason = `command uses shell syntax (${shellSyntax}) the executor cannot run directly`;
  }
  return planned;
}

/**
 * Resolve the check plan for a project-scoped workspace. Precedence:
 *   1. Explicit `.harness/checks.yml` (operator override) — highest.
 *   2. The project's generated quality-gate config once it exists:
 *        - `ready` -> its evidence-backed blocking checks.
 *        - `generating`/`incomplete`/`failed` -> a no-blocking-checks plan that
 *          surfaces the gate state. The gate never substitutes a generic gate here.
 *   3. Generic `package.json`/`Makefile` detection (the shared baseline), used
 *      only before generation has started (`pending`).
 *
 * Advisory (`required: false`) checks are informational and excluded from the
 * blocking plan. A `projectId` of `undefined` (harness-level tasks) always uses
 * the workspace-local planner, so the harness's own gate is unaffected.
 */
export async function planProjectChecks(
  root: string,
  projectId: string | undefined,
  workspacePath: string
): Promise<CheckPlan> {
  const baseline = await planChecks(workspacePath);
  if (!projectId) return baseline;
  if (baseline.source === "checks.yml") return baseline; // explicit operator override wins

  const gate = await readProjectQualityGate(root, projectId);

  // `pending` means generation has not started yet, so baseline detection is the
  // documented interim. Once generation begins the no-generic-gate contract
  // holds: a project-specific gate is pending (not absent), so evidence gaps and
  // in-flight state surface instead of a one-size-fits-all gate running in the
  // meantime.
  if (gate.status === "pending") return baseline;

  if (gate.status !== "ready") {
    // `generating` (turn in flight), `incomplete` (insufficient evidence), or
    // `failed` (could not gather intel): the gate cannot drive blocking checks.
    // Surface a quality-gate plan with no blocking checks, carrying the state as
    // a note so the author prompt and checks-outcome message explain it rather
    // than reading as an ordinary no-checks pass.
    return {
      checks: [],
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
      source: "quality-gate",
      resolutionNote: describeGateResolution(gate)
    };
  }

  // Re-enforce verify-don't-mutate at the plan boundary. Stored configs are re-read
  // with only a loose shape check, so a pre-fix or hand-edited config may carry a
  // mutating/network command (publish/deploy/serve/release) or an unrecognized
  // 'other' command as required. Only a required check in a known verification
  // category that is not a mutating command may block, mirroring how the
  // path-containment and shell-syntax guards are re-applied here, never trusting a
  // persisted field alone to decide what runs every turn.
  const blocking = gate.checks.filter(
    (check) =>
      check.required !== false && isVerificationCategory(check.category) && !isMutatingCommand(check.command)
  );
  if (blocking.length === 0) {
    return { checks: [], maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS, source: "quality-gate" };
  }
  return {
    checks: blocking.map(gateCheckToPlanned),
    maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
    source: "quality-gate"
  };
}

/** Run checks for a project-scoped workspace using its generated gate when ready. */
export async function runProjectChecks(
  root: string,
  projectId: string | undefined,
  workspacePath: string,
  onChunk?: (chunk: string) => void
): Promise<CheckSummary> {
  return runCheckPlan(await planProjectChecks(root, projectId, workspacePath), workspacePath, onChunk);
}

/**
 * Run a project's quality-gate checks against its repo on demand (the "Run" button).
 * When `checkName` is given, run only that check; otherwise run all of them. Unlike
 * `runProjectChecks` (which runs only the blocking subset each task turn), this runs
 * every check in the gate config — advisory ones too — because the operator asked.
 *
 * Safety: a hand-edited config can't escalate into running publish/deploy/install
 * here. The same guards the planner applies become explicit skips with a reason:
 * shell syntax the direct-spawn executor cannot honour, and mutating/network commands
 * (the gate verifies; it does not mutate).
 */
export async function runProjectGateChecks(
  root: string,
  projectId: string,
  repoPath: string,
  checkName?: string,
  onChunk?: (chunk: string) => void
): Promise<CheckSummary> {
  const gate = await readProjectQualityGate(root, projectId);
  const selectable = checkName ? gate.checks.filter((check) => check.name === checkName) : gate.checks;
  const plan: CheckPlan = {
    checks: selectable.map((check) => {
      const planned = gateCheckToPlanned(check);
      if (isMutatingCommand(check.command)) {
        planned.available = false;
        planned.skipReason = "mutating/network command; the gate verifies, it does not mutate";
      }
      return planned;
    }),
    maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
    source: "quality-gate"
  };
  return runCheckPlan(plan, repoPath, onChunk);
}
