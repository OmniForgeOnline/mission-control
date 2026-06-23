import path from "node:path";

import { listRuns } from "../../core/tasks/runs.ts";
import { listTasks } from "../../core/tasks/tasks.ts";
import { projectDir } from "../../core/projects/registry.ts";
import { readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import { runAutonomyAgentTurn } from "../agent-run.ts";
import { now } from "../job-schedule.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

interface ReviewedEntry {
  runId: string;
  reviewedAt: string;
}

export async function runProjectEvolutionReview(
  root: string,
  _context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = _context?.project;
  if (!project) throw new Error("Missing project context.");

  const reviewedPath = path.join(projectDir(root, project.id), "evolution-reviewed.json");
  const reviewed = await readJsonFile<ReviewedEntry[]>(reviewedPath, []);
  const reviewedIds = new Set(reviewed.map((e) => e.runId));

  const allRuns = await listRuns(root, project.id);
  const projectTasks = (await listTasks(root)).filter(
    (t) => t.repoPath === project.repoPath || t.targets.some((tgt) => tgt.path.startsWith(project.repoPath))
  );
  const projectTaskIds = new Set(projectTasks.map((t) => t.id));

  const projectRuns = allRuns
    .filter((run) => run.status === "completed" && projectTaskIds.has(run.taskId) && !reviewedIds.has(run.id))
    .slice(0, 10);

  if (!projectRuns.length) {
    return {
      jobId: "turn-evolution-review",
      status: "completed",
      summary: `No unreviewed completed runs for ${project.name}.`,
      proposalsCreated: 0
    };
  }

  const ctx = [
    `Project: ${project.name} (${project.repoPath})`,
    `Unreviewed project runs: ${projectRuns.length}`,
    "",
    ...projectRuns.map((r) => `- ${r.id.slice(0, 8)} · ${r.status} · ${r.taskTitle}`)
  ].join("\n");

  const prompt = `You are reviewing the project "${project.name}" at ${project.repoPath} for cross-run patterns.

## Mandate

1. Study the run snapshots below. Use \`read_task\`, \`read_run\`, \`list_runs\` to investigate.
2. Look for recurring friction in this project's workflows and codebase.
3. Queue fixes via \`tech_debt_capture(projectId: "${project.id}")\`.
4. Do NOT use \`propose_rule\`, \`propose_skill\`, \`propose_hook\`, or \`gbrain_propose\`.
5. Do NOT edit project files directly.

## Project runs

${ctx}

## Output

End with a short summary: how many runs reviewed, which patterns found, which debt items captured. If nothing actionable, say so.`;

  const spec = {
    taskId: `autonomy:project:${project.id}:turn-evolution-review`,
    taskTitle: `Evolution review: ${project.name}`,
    projectId: project.id,
    repoPath: project.repoPath,
    stateFileName: `${project.id}/evolution-review.json`,
    skipSummary: "Already running.",
    completedSummary: (n: number, p: number) => `Evolution review turn ${n} for ${project.name}; ${p} debt item(s).`,
    blockedSummary: (reason: string) => `Evolution review blocked for ${project.name}: ${reason}`,
    buildContext: async () => ctx,
    buildPrompt: (_context: string) => prompt,
    afterTurn: async () => {
      const entries: ReviewedEntry[] = projectRuns.map((r) => ({ runId: r.id, reviewedAt: now() }));
      await writeJsonFile(reviewedPath, [...reviewed, ...entries]);
    }
  };

  const result = await runAutonomyAgentTurn(root, spec);
  return {
    jobId: "turn-evolution-review",
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
}
