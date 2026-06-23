import { listOpenOperationalErrors, markOperationalErrorsTriaged, type OperationalError } from "../core/operations/error-ledger.ts";
import { runAutonomyAgentTurn, type RunAutonomyAgentOptions } from "./agent-run.ts";

export type { RunAutonomyAgentOptions };

export const ERROR_TRIAGE_TASK_ID = "autonomy:operational-error-triage";

let pendingTriageErrorIds: string[] = [];

function formatErrorSnapshot(error: OperationalError): string {
  const meta = [
    error.taskId ? `task=${error.taskId.slice(0, 8)}` : null,
    error.runId ? `run=${error.runId.slice(0, 8)}` : null,
    error.workflowStep ? `step=${error.workflowStep}` : null
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `### Error ${error.id.slice(0, 8)} · ${error.capturedAt.slice(0, 19)}${meta ? ` · ${meta}` : ""}`,
    error.taskTitle ? `Task: ${error.taskTitle}` : "",
    "",
    error.message,
    ""
  ]
    .filter((line, index, arr) => line !== "" || (index > 0 && arr[index - 1] !== ""))
    .join("\n");
}

export async function buildErrorTriageContext(root: string): Promise<string> {
  const errors = await listOpenOperationalErrors(root);
  pendingTriageErrorIds = errors.map((error) => error.id);
  const lines = errors.map(formatErrorSnapshot);
  return [
    `Open operational errors: ${errors.length}`,
    "",
    "Investigate each error with MCP tools (`read_task`, `read_run`, `list_runs`, `gbrain_search`).",
    "",
    ...lines
  ].join("\n");
}

export function buildErrorTriagePrompt(context: string): string {
  return `You are the harness operational-error triage agent on a scheduled autonomy run.

Your job is to analyze runtime failures captured during normal harness usage and turn **recurring or high-impact harness-platform issues** into actionable fix work.

## Mandate

1. Study the captured errors below. Use \`read_task\`, \`read_run(runId, "log.txt")\`, and \`read_run(runId, "summary.md")\` to understand root cause.
2. Classify each error:
   - **Harness bug / missing automation** → file implementation work via \`tech_debt_capture\` (preferred for code fixes) or \`propose_rule\` / \`propose_skill\` for small policy/playbook updates.
   - **One-off task mistake / destination-repo issue** → skip (do not file platform debt).
   - **Already remediated or transient** → skip.
3. Be precise in \`tech_debt_capture\` descriptions: root cause, affected files under \`src/\`, and acceptance criteria.
4. Do NOT file duplicate tech-debt items for the same root cause already in \`state/tech-debt.json\`.
5. Do NOT edit harness files directly.

## What to prioritize

- Harness workflow/daemon bugs: push/MR advancement stalls, agent routing, worktree lifecycle, connector failures
- Errors that will recur on every similar task until the platform is fixed

## Already handled in-workflow (ledger should not contain these)

- Lint/pre-commit/eslint failures from the author's own edits
- Mechanical check failures and commit-hook rejections on the task branch
- Those are retried by the author agent inside the same workflow; do not re-file them as platform debt

## Captured errors

${context}

## Output

End with a short operator handoff: how many errors you reviewed, which \`tech_debt_capture\` / \`propose_*\` tickets you filed (titles only), and which errors you skipped as non-platform noise.`;
}

const errorTriageSpec = {
  taskId: ERROR_TRIAGE_TASK_ID,
  taskTitle: "Operational error triage",
  stateFileName: "error-triage.json",
  skipSummary: "Error triage skipped: already running.",
  completedSummary: (turnNumber: number, proposalsCreated: number) =>
    `Error triage turn ${turnNumber} completed; filed ${proposalsCreated} proposal(s).`,
  blockedSummary: (reason: string) => `Error triage blocked: ${reason}`,
  buildContext: buildErrorTriageContext,
  buildPrompt: buildErrorTriagePrompt,
  preflight: async (root: string) => {
    const errors = await listOpenOperationalErrors(root);
    if (!errors.length) {
      pendingTriageErrorIds = [];
      return "No open operational errors.";
    }
    return null;
  },
  afterTurn: async (root: string) => {
    await markOperationalErrorsTriaged(root, pendingTriageErrorIds);
    pendingTriageErrorIds = [];
  }
};

export interface ErrorTriageResult {
  runId: string;
  status: "completed" | "blocked";
  summary: string;
  proposalsCreated: number;
}

export async function runOperationalErrorTriage(
  root: string,
  options?: RunAutonomyAgentOptions
): Promise<ErrorTriageResult> {
  return runAutonomyAgentTurn(root, errorTriageSpec, options);
}