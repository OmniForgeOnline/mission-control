import {
  DEFAULT_CHECK_REMEDIATION_ROUNDS,
  planChecks,
  runCheckPlan,
  type CheckKind,
  type CheckPlan,
  type CheckSummary,
  type PlannedCheck
} from "../review/checks.ts";
import { isRepoRelativePath, readProjectQualityGate, type QualityGateCheck } from "./quality-gate.ts";

/** Map a generated quality-gate category onto a canonical check kind, if any. */
function gateCategoryToKind(category: QualityGateCheck["category"]): CheckKind | undefined {
  if (category === "lint" || category === "test" || category === "typecheck") return category;
  return undefined;
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
    // checks rather than substituting generic package.json/Makefile detection.
    return { checks: [], maxRounds: DEFAULT_CHECK_REMEDIATION_ROUNDS, source: "quality-gate" };
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
