import path from "node:path";

import { listTasks } from "../../core/tasks/tasks.ts";
import { listRuns } from "../../core/tasks/runs.ts";
import { readJsonFile } from "../../core/infra/fs.ts";
import { projectDir } from "../../core/projects/registry.ts";
import { runAutonomyAgentTurn } from "../agent-run.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";
import type { QualityFile } from "../../core/quality/quality.ts";

export async function runProjectSelfImprovement(
  root: string,
  _context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = _context?.project;
  if (!project) throw new Error("Missing project context.");

  const allTasks = await listTasks(root);
  const projectTasks = allTasks.filter(
    (t) => t.repoPath === project.repoPath || t.targets.some((tgt) => tgt.path.startsWith(project.repoPath))
  );
  const projectTaskIds = new Set(projectTasks.map((t) => t.id));

  const allRuns = await listRuns(root, project.id);
  const projectRuns = allRuns.filter((r) => projectTaskIds.has(r.taskId));

  const qualityPath = path.join(projectDir(root, project.id), "quality.json");
  const quality = await readJsonFile<QualityFile>(qualityPath, { updatedAt: "", domains: {} });

  const taskLines = projectTasks.slice(0, 12).map((t) => {
    const status = t.resolution ?? (t.blockedReason ? "blocked" : "active");
    return `- ${t.id.slice(0, 8)} · ${status} · "${t.title}"`;
  });
  const runLines = projectRuns.slice(0, 8).map((r) => `- ${r.id.slice(0, 8)} · ${r.status} · ${r.taskTitle}`);
  const domainLines = quality.domains
    ? Object.entries(quality.domains).map(([d, e]) => `- ${d}: grade ${e.grade}`)
    : ["- no quality data"];

  const ctx = [
    `Project: ${project.name} (${project.repoPath})`,
    "",
    "Recent project tasks:",
    taskLines.length ? taskLines.join("\n") : "- none",
    "",
    "Recent project runs:",
    runLines.length ? runLines.join("\n") : "- none",
    "",
    "Quality summary:",
    ...domainLines
  ].join("\n");

  const prompt = `You are improving the project "${project.name}" at ${project.repoPath}.

## Mandate

1. Review the project snapshot below. Use \`list_tasks\`, \`read_task\`, \`list_runs\`, \`read_run\` to investigate.
2. Improve the project through normal tasks, not direct edits.
3. For substantial work, use \`tech_debt_capture(projectId: "${project.id}")\`.
4. Do NOT use \`propose_rule\`, \`propose_skill\`, \`propose_hook\`, or \`gbrain_propose\`.
5. Do NOT edit project files directly.

## Project snapshot

${ctx}

## Output

End with a short summary of what you reviewed and which tasks or debt items you created. If nothing needs changing, say so.`;

  const spec = {
    taskId: `autonomy:project:${project.id}:self-improvement`,
    taskTitle: `Self-improvement: ${project.name}`,
    projectId: project.id,
    repoPath: project.repoPath,
    stateFileName: `${project.id}/self-improvement.json`,
    skipSummary: "Already running.",
    completedSummary: (n: number, p: number) => `Self-improvement turn ${n} for ${project.name}; ${p} item(s).`,
    blockedSummary: (reason: string) => `Self-improvement blocked for ${project.name}: ${reason}`,
    buildContext: async () => ctx,
    buildPrompt: (_context: string) => prompt
  };

  const result = await runAutonomyAgentTurn(root, spec);
  return {
    jobId: "project-self-improvement",
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
}
