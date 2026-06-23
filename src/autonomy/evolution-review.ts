import path from "node:path";

import { readJsonFile, writeJsonFile } from "../core/infra/fs.ts";
import { listAllRuns } from "../core/tasks/runs.ts";
import { runAutonomyAgentTurn, type RunAutonomyAgentOptions } from "./agent-run.ts";
import { evolutionReviewedPath } from "./job-types.ts";
import { now } from "./job-schedule.ts";
import { readOptionalFile } from "./handlers/shared.ts";

export const EVOLUTION_REVIEW_TASK_ID = "autonomy:turn-evolution-review";

const MAX_RUNS_PER_TURN = 10;
const SUMMARY_EXCERPT_CHARS = 1200;

interface EvolutionReviewedEntry {
  runId: string;
  reviewedAt: string;
}

interface RunSnapshot {
  id: string;
  taskTitle: string;
  agent: string;
  completedAt?: string;
  summaryExcerpt: string;
}

let pendingReviewRunIds: string[] = [];

async function loadUnreviewedRuns(root: string): Promise<RunSnapshot[]> {
  const reviewed = await readJsonFile<EvolutionReviewedEntry[]>(evolutionReviewedPath(root), []);
  const reviewedIds = new Set(reviewed.map((entry) => entry.runId));

  const allRuns = await listAllRuns(root);
  const completed = allRuns
    .filter((run) => run.status === "completed" && !reviewedIds.has(run.id))
    .slice(0, MAX_RUNS_PER_TURN);

  const snapshots: RunSnapshot[] = [];
  for (const run of completed) {
    const summaryPath = path.join(root, "data", "runs", run.id, "summary.md");
    const content = await readOptionalFile(summaryPath);
    snapshots.push({
      id: run.id,
      taskTitle: run.taskTitle,
      agent: run.agent,
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      summaryExcerpt: content ? content.trim().slice(0, SUMMARY_EXCERPT_CHARS) : "(no summary.md)"
    });
  }

  pendingReviewRunIds = snapshots.map((snapshot) => snapshot.id);
  return snapshots;
}

export async function buildEvolutionReviewContext(root: string): Promise<string> {
  const snapshots = await loadUnreviewedRuns(root);
  const lines = snapshots.map((snapshot) => {
    const completed = snapshot.completedAt ? snapshot.completedAt.slice(0, 19) : "—";
    return [
      `### Run ${snapshot.id.slice(0, 8)} · ${snapshot.taskTitle} (${snapshot.agent}) · completed ${completed}`,
      "",
      snapshot.summaryExcerpt,
      ""
    ].join("\n");
  });

  return [
    `Unreviewed completed runs: ${snapshots.length}`,
    "",
    "Use `read_run(runId, \"summary.md\" | \"log.txt\")` for full artifacts when an excerpt is truncated.",
    "",
    ...lines
  ].join("\n");
}

export function buildEvolutionReviewPrompt(context: string): string {
  return `You are the harness evolution-review agent on a scheduled autonomy run.

Your job is to find **cross-run patterns** — recurring bugs, failure modes, operator friction, tool errors, or workflow stalls that appear across multiple recent agent runs — and turn them into durable harness improvements.

## Mandate

1. Study the run snapshots below, then investigate deeper with MCP: \`read_run\`, \`read_task\`, \`list_runs\`, \`gbrain_search\`, \`kernel_read\`, \`read_skill\`.
2. Look for patterns that repeat across runs (same root cause, same confusion, same missing skill, same daemon edge case) — not one-off task outcomes.
3. Submit harness improvements via \`propose_skill\` (playbooks/checklists), \`propose_rule\` (kernel policy), or \`propose_hook\`. Use \`gbrain_propose\` for operator-facing lessons that belong in personal memory, not repo-backed harness files.
4. Do NOT file duplicate \`propose_*\` tickets for a target that already has an active proposal. For substantial implementation work, use \`tech_debt_capture\` instead.
5. Do NOT edit harness files directly.

## What counts as a cross-run pattern

- The same MCP/tool error in multiple runs
- Tasks stalling on the same workflow step for the same reason
- Agents repeating the same wrong assumption about harness behavior
- Missing documentation that multiple runs had to rediscover
- Recurring test/infra failures across unrelated tasks

## What to skip

- Generic task completion narratives with no reusable lesson
- Patterns visible in only one run (unless severe and likely to recur)
- Application-code fixes in destination repos (this job improves the harness platform)

## Run snapshots

${context}

## Output

End with a short operator handoff: how many runs you reviewed, which cross-run patterns you found (if any), and which tickets you filed via \`propose_*\` (titles only). If nothing actionable, say so explicitly and why.`;
}

async function markRunsReviewed(root: string): Promise<void> {
  if (!pendingReviewRunIds.length) return;
  const reviewed = await readJsonFile<EvolutionReviewedEntry[]>(evolutionReviewedPath(root), []);
  const timestamp = now();
  const newEntries = pendingReviewRunIds.map((runId) => ({ runId, reviewedAt: timestamp }));
  await writeJsonFile(evolutionReviewedPath(root), [...reviewed, ...newEntries]);
  pendingReviewRunIds = [];
}

const evolutionReviewSpec = {
  taskId: EVOLUTION_REVIEW_TASK_ID,
  taskTitle: "Turn evolution review",
  stateFileName: "evolution-review.json",
  skipSummary: "Evolution review skipped: already running.",
  completedSummary: (turnNumber: number, proposalsCreated: number) =>
    `Evolution review turn ${turnNumber} completed; filed ${proposalsCreated} proposal(s).`,
  blockedSummary: (reason: string) => `Evolution review blocked: ${reason}`,
  buildContext: buildEvolutionReviewContext,
  buildPrompt: buildEvolutionReviewPrompt,
  preflight: async (root: string) => {
    const snapshots = await loadUnreviewedRuns(root);
    if (!snapshots.length) {
      pendingReviewRunIds = [];
      return "No unreviewed completed runs.";
    }
    return null;
  },
  afterTurn: markRunsReviewed
};

export interface EvolutionReviewResult {
  runId: string;
  status: "completed" | "blocked";
  summary: string;
  proposalsCreated: number;
}

export async function runTurnEvolutionReview(
  root: string,
  options?: RunAutonomyAgentOptions
): Promise<EvolutionReviewResult> {
  return runAutonomyAgentTurn(root, evolutionReviewSpec, options);
}