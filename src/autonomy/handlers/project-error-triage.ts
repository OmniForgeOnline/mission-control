import path from "node:path";

import { listTasks } from "../../core/tasks/tasks.ts";
import { readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import { projectDir } from "../../core/projects/registry.ts";
import { runAutonomyAgentTurn } from "../agent-run.ts";
import { now } from "../job-schedule.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

interface TriageReviewedEntry {
  taskId: string;
  reviewedAt: string;
}

export async function runProjectErrorTriage(
  root: string,
  _context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = _context?.project;
  if (!project) throw new Error("Missing project context.");

  const reviewedPath = path.join(projectDir(root, project.id), "triage-reviewed.json");
  const reviewed = await readJsonFile<TriageReviewedEntry[]>(reviewedPath, []);
  const reviewedIds = new Set(reviewed.map((e) => e.taskId));

  const allTasks = await listTasks(root);
  const blockedTasks = allTasks.filter(
    (t) =>
      (t.repoPath === project.repoPath || t.targets.some((tgt) => tgt.path.startsWith(project.repoPath))) &&
      t.blockedReason &&
      !reviewedIds.has(t.id)
  );

  if (!blockedTasks.length) {
    return {
      jobId: "project-operational-triage",
      status: "completed",
      summary: `No blocked project tasks to triage for ${project.name}.`,
      proposalsCreated: 0
    };
  }

  const lines = blockedTasks.map((t) => `- ${t.id.slice(0, 8)} · "${t.title}" · ${t.blockedReason ?? "unknown"}`);
  const ctx = [
    `Project: ${project.name} (${project.repoPath})`,
    `Blocked/recent project tasks: ${blockedTasks.length}`,
    "",
    ...lines
  ].join("\n");

  const prompt = `You are triaging recurring failures in the project "${project.name}" at ${project.repoPath}.

## Mandate

1. Study the blocked/recent tasks below. Use \`read_task\`, \`read_run\` to investigate.
2. Look for recurring failures in this project context.
3. When the same failure is likely to recur, capture tech debt via \`tech_debt_capture(projectId: "${project.id}")\`.
4. Do NOT use \`propose_rule\`, \`propose_skill\`, \`propose_hook\`, or \`gbrain_propose\`.
5. Do NOT read or write the platform operational-errors ledger.

## Blocked project tasks

${ctx}

## Output

End with a short summary of what you triaged and which debt items you captured. If nothing is recurring, say so.`;

  const spec = {
    taskId: `autonomy:project:${project.id}:operational-triage`,
    taskTitle: `Operational triage: ${project.name}`,
    projectId: project.id,
    repoPath: project.repoPath,
    stateFileName: `${project.id}/triage.json`,
    skipSummary: "Already running.",
    completedSummary: (n: number, p: number) => `Triage turn ${n} for ${project.name}; ${p} debt item(s).`,
    blockedSummary: (reason: string) => `Triage blocked for ${project.name}: ${reason}`,
    buildContext: async () => ctx,
    buildPrompt: (_context: string) => prompt,
    afterTurn: async () => {
      const entries: TriageReviewedEntry[] = blockedTasks.map((t) => ({ taskId: t.id, reviewedAt: now() }));
      await writeJsonFile(reviewedPath, [...reviewed, ...entries]);
    }
  };

  const result = await runAutonomyAgentTurn(root, spec);
  return {
    jobId: "project-operational-triage",
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
}
