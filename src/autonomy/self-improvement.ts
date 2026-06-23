import { access } from "node:fs/promises";

import { listProposalTasks, proposalTaskToRecord } from "../core/proposals/proposals.ts";
import { deriveLegacyStatus } from "../core/tasks/status.ts";
import { DEFAULT_WORKFLOW_ID, loadWorkflow } from "../core/workflows/index.ts";
import { parseProposalFields } from "../core/proposals/ticket.ts";
import { readJsonFile } from "../core/infra/fs.ts";
import { listAllRuns } from "../core/tasks/runs.ts";
import { listTasks } from "../core/tasks/tasks.ts";
import { worktreePathFor } from "../core/worktrees/worktrees.ts";
import type { HarnessTask } from "../core/types.ts";
import { AUTONOMY_AGENT_STALE_LOCK_MS, runAutonomyAgentTurn, type RunAutonomyAgentOptions } from "./agent-run.ts";
import { autonomyRunsPath, type AutonomyRunResult } from "./job-types.ts";
import { listAutonomyJobs } from "./jobs.ts";

const HIGHLIGHT_JOB_IDS = [
  "worktree-cleanup-sweep",
  "workflow-reconcile-sweep",
  "clickup-ticket-sync"
] as const;

export const SELF_IMPROVEMENT_TASK_ID = "autonomy:harness-self-improvement";
export const SELF_IMPROVEMENT_STALE_LOCK_MS = AUTONOMY_AGENT_STALE_LOCK_MS;

async function countWorktrees(root: string, tasks: HarnessTask[]): Promise<number> {
  let count = 0;
  for (const task of tasks) {
    if (!task.repoPath) continue;
    try {
      await access(worktreePathFor(root, task));
      count++;
    } catch {
      /* absent */
    }
  }
  return count;
}

function formatAutonomyRunEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const jobId = typeof record["jobId"] === "string" ? record["jobId"] : "unknown";
  const summary = typeof record["summary"] === "string" ? record["summary"] : "—";
  return `- ${jobId} · ${summary}`;
}

async function loadRecentAutonomyRunLines(root: string): Promise<string[]> {
  const history = await readJsonFile<AutonomyRunResult[]>(autonomyRunsPath(root), []);
  return history
    .slice(0, 5)
    .map(formatAutonomyRunEntry)
    .filter((line): line is string => line !== null);
}

async function loadJobHighlightLines(root: string): Promise<string[]> {
  const jobs = await listAutonomyJobs(root);
  const byId = new Map(jobs.map((job) => [job.id, job] as const));
  return HIGHLIGHT_JOB_IDS.map((jobId) => {
    const summary = byId.get(jobId)?.lastSummary ?? "—";
    return `- ${jobId}: ${summary}`;
  });
}

export async function buildSelfImprovementContext(root: string): Promise<string> {
  const tasks = await listTasks(root);
  const runs = await listAllRuns(root);
  const proposalTasks = await listProposalTasks(root);
  const worktrees = await countWorktrees(root, tasks);

  const interestingTasks = tasks
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12);

  const workflowCache = new Map<string, Awaited<ReturnType<typeof loadWorkflow>>>();
  const taskLines = await Promise.all(
    interestingTasks.map(async (task) => {
      const workflowId = task.workflowRun?.workflowId ?? DEFAULT_WORKFLOW_ID;
      let workflow = workflowCache.get(workflowId);
      if (!workflow) {
        workflow = await loadWorkflow(root, workflowId);
        workflowCache.set(workflowId, workflow);
      }
      const legacyStatus = deriveLegacyStatus(task, workflow);
      const step = task.workflowRun?.currentStepId ?? "—";
      const mr = task.mergeRequest ? `${task.mergeRequest.provider} #${task.mergeRequest.number}` : "—";
      const cleaned = task.worktreeCleanedAt ? "yes" : "no";
      return `- ${task.id.slice(0, 8)} · ${legacyStatus} · step=${step} · turns=${task.turnCount ?? 0} · pushed=${task.pushedAt ? "yes" : "no"} · MR=${mr} · worktree_cleaned=${cleaned} · "${task.title}"`;
    })
  );

  const recentRuns = runs
    .filter((run) => run.status === "completed" || run.status === "blocked")
    .slice(0, 8)
    .map((run) => `- ${run.id.slice(0, 8)} · ${run.status} · ${run.taskTitle} (${run.agent})`);

  const activeProposalTasks = proposalTasks.filter((task) => !task.resolution);
  const activeProposalLines = activeProposalTasks
    .slice(0, 12)
    .map((task) => {
      const fields = parseProposalFields(task);
      const status = proposalTaskToRecord(task).status;
      return `- ${task.id.slice(0, 8)} · ${status} · [${fields.kind}] ${task.title} → ${fields.targetPath}`;
    });

  const autonomyRunLines = await loadRecentAutonomyRunLines(root);
  const jobHighlightLines = await loadJobHighlightLines(root);

  return [
    `Active proposal tickets: ${activeProposalTasks.length}`,
    activeProposalLines.length ? activeProposalLines.join("\n") : "- none",
    "",
    `Active worktrees on disk: ${worktrees}`,
    "",
    "Recent tasks:",
    taskLines.length ? taskLines.join("\n") : "- none",
    "",
    "Recent runs:",
    recentRuns.length ? recentRuns.join("\n") : "- none",
    "",
    "Recent autonomy runs:",
    autonomyRunLines.length ? autonomyRunLines.join("\n") : "- none",
    "",
    "Autonomy job highlights:",
    jobHighlightLines.join("\n")
  ].join("\n");
}

export function buildSelfImprovementPrompt(context: string): string {
  return `You are the harness self-improvement agent on a scheduled autonomy run.

Spend this turn reviewing how the harness has been operating and draft concrete, actionable improvements. You are improving the harness platform itself — not application code in destination repos.

## Mandate

1. Investigate with MCP tools: \`list_tasks\`, \`read_task\`, \`list_runs\`, \`read_run\`, \`gbrain_search\`, \`kernel_read\`, \`read_skill\`. Harness changes filed via \`propose_*\` appear as normal tasks (\`source: manual\`).
2. Look for workflow bugs, operator friction, stale guidance, missing automation, and storage hygiene issues (orphaned worktrees, tasks stuck on wrong steps).
3. Submit repo-backed harness changes via \`propose_rule\`, \`propose_skill\`, or \`propose_hook\`. Use \`gbrain_propose\` for personal memory (writes locally to gitignored \`data/memory/pages/\`, no task/worktree). Never edit \`kernel/\`, \`skills/\`, \`hooks/\`, or memory files directly. Do NOT file duplicate \`propose_*\` tickets for a target path that already has an active proposal ticket in the snapshot below.
4. When a fix needs a full implementation pass, use \`tech_debt_capture\` so \`tech-debt-sweep\` can queue a synthetic task.

## Focus this run

- Workflow advancement after git push (implement → checks → create_merge_request → review)
- Unnecessary \`awaiting_operator\` pauses when work is already pushed or complete
- Worktree cleanup after merged PRs
- Kernel/skill wording that no longer matches daemon behavior
- Autonomy job gaps (things operators keep doing manually)

## Recent harness snapshot

${context}

## Output

End with a short operator handoff listing what you reviewed and which tickets you filed via \`propose_*\` (titles only). If nothing needs changing, say so explicitly and why.`;
}

const selfImprovementSpec = {
  taskId: SELF_IMPROVEMENT_TASK_ID,
  taskTitle: "Harness self-improvement",
  stateFileName: "self-improvement.json",
  skipSummary: "Self-improvement skipped: already running.",
  completedSummary: (turnNumber: number, proposalsCreated: number) =>
    `Self-improvement turn ${turnNumber} completed; filed ${proposalsCreated} proposal(s).`,
  blockedSummary: (reason: string) => `Self-improvement turn blocked: ${reason}`,
  buildContext: buildSelfImprovementContext,
  buildPrompt: buildSelfImprovementPrompt
};

export interface SelfImprovementResult {
  runId: string;
  status: "completed" | "blocked";
  summary: string;
  proposalsCreated: number;
}

export async function runHarnessSelfImprovement(
  root: string,
  options?: RunAutonomyAgentOptions
): Promise<SelfImprovementResult> {
  return runAutonomyAgentTurn(root, selfImprovementSpec, options);
}