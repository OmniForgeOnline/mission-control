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
  isRepoRelativePath,
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
 * Carries the `needsResolution` gaps (`incomplete`) or the `error` (`failed`)
 * through the check plan so they reach the author prompt and checks-outcome
 * message instead of collapsing to an ordinary no-checks run.
 */
function describeGateResolution(gate: QualityGateFile): string {
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
 *        - `incomplete`/`failed` -> a no-blocking-checks plan that surfaces the
 *          needs-resolution state. The gate never substitutes a generic gate here.
 *   3. Generic `package.json`/`Makefile` detection (the shared baseline), used
 *      only while no config has been produced yet (`pending`/`generating`).
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

  // Nothing produced yet: baseline detection is the documented interim. Once a
  // config exists it always wins, so evidence gaps surface instead of silently
  // running a one-size-fits-all gate.
  if (gate.status === "pending" || gate.status === "generating") return baseline;

  if (gate.status !== "ready") {
    // `incomplete` (insufficient evidence) or `failed` (could not gather intel):
    // the operator must resolve. Surface a quality-gate plan with no blocking
    // checks, but carry the resolution state as a note so the author prompt and
    // the checks-outcome message explain what the operator must do rather than
    // reading as an ordinary no-checks pass.
    return {
      checks: [],
      maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS,
      source: "quality-gate",
      resolutionNote: describeGateResolution(gate)
    };
  }

  const blocking = gate.checks.filter((check) => check.required !== false);
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
