import { listTasks } from "../../core/tasks/tasks.ts";
import { listRuns } from "../../core/tasks/runs.ts";
import { type ProjectRecord } from "../../core/projects/registry.ts";
import { readProjectQualityGate, readProjectQualityGateRun } from "../../core/projects/quality-gate.ts";
import { runAutonomyAgentTurn } from "../agent-run.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

type ProjectRef = Pick<ProjectRecord, "id" | "name" | "repoPath">;

/**
 * Build the project snapshot the self-improvement agent reasons over: recent
 * tasks/runs and the quality-gate state (config + the last on-demand run's actual
 * pass/fail), so it can act on real verification outcomes rather than a heuristic.
 */
export async function buildProjectSelfImprovementContext(
  root: string,
  project: ProjectRef
): Promise<string> {
  const allTasks = await listTasks(root);
  const projectTasks = allTasks.filter(
    (t) => t.repoPath === project.repoPath || t.targets.some((tgt) => tgt.path.startsWith(project.repoPath))
  );
  const projectTaskIds = new Set(projectTasks.map((t) => t.id));

  const allRuns = await listRuns(root, project.id);
  const projectRuns = allRuns.filter((r) => projectTaskIds.has(r.taskId));

  const taskLines = projectTasks.slice(0, 12).map((t) => {
    const status = t.resolution ?? (t.blockedReason ? "blocked" : "active");
    return `- ${t.id.slice(0, 8)} · ${status} · "${t.title}"`;
  });
  const runLines = projectRuns.slice(0, 8).map((r) => `- ${r.id.slice(0, 8)} · ${r.status} · ${r.taskTitle}`);

  // The gate itself: config state, evidence gaps, and the last run's real results.
  const gate = await readProjectQualityGate(root, project.id);
  const lastRun = await readProjectQualityGateRun(root, project.id);
  const gateLines: string[] = [`- status: ${gate.status}`];
  if (gate.checks.length) gateLines.push(`- checks: ${gate.checks.map((c) => c.name).join(", ")}`);
  if (gate.needsResolution?.length) gateLines.push(`- gaps: ${gate.needsResolution.join("; ")}`);
  if (gate.error) gateLines.push(`- error: ${gate.error}`);
  if (lastRun) {
    const failing = lastRun.results
      .filter((r) => r.status === "failed")
      .map((r) => `${r.name} (exit ${r.exitCode})`);
    gateLines.push(
      `- last run (${lastRun.runAt}): ${failing.length ? `failed — ${failing.join(", ")}` : "passed"}`
    );
  }

  return [
    `Project: ${project.name} (${project.repoPath})`,
    "",
    "Recent project tasks:",
    taskLines.length ? taskLines.join("\n") : "- none",
    "",
    "Recent project runs:",
    runLines.length ? runLines.join("\n") : "- none",
    "",
    "Quality gate:",
    ...gateLines
  ].join("\n");
}

export function buildProjectSelfImprovementPrompt(project: ProjectRef, context: string): string {
  return `You are improving the project "${project.name}" at ${project.repoPath}.

## Mandate

1. Review the project snapshot below. Use \`list_tasks\`, \`read_task\`, \`list_runs\`, \`read_run\` to investigate.
2. Improve the project through normal tasks, not direct edits.
3. For substantial work, use \`tech_debt_capture(projectId: "${project.id}")\`.
4. Do NOT use \`propose_rule\`, \`propose_skill\`, \`propose_hook\`, or \`gbrain_propose\`.
5. Do NOT edit project files directly.
6. Raise quality via the gate: if the quality gate is \`incomplete\`, propose resolving its gaps; if the last gate run has failing checks, propose fixes via \`tech_debt_capture(projectId: "${project.id}")\`. The gate verifies the repo, so never propose skipping a check just to make it pass.

## Project snapshot

${context}

## Output

End with a short summary of what you reviewed and which tasks or debt items you created. If nothing needs changing, say so.`;
}

export async function runProjectSelfImprovement(
  root: string,
  _context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = _context?.project;
  if (!project) throw new Error("Missing project context.");

  const ctx = await buildProjectSelfImprovementContext(root, project);
  const prompt = buildProjectSelfImprovementPrompt(project, ctx);

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
    buildPrompt: () => prompt
  };

  const result = await runAutonomyAgentTurn(root, spec);
  return {
    jobId: "project-self-improvement",
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
}
