import { runAutonomyAgentTurn } from "../agent-run.ts";
import { buildGuidanceSweepContext, buildGuidanceSweepPrompt } from "../guidance-sweep.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

/**
 * Harness guidance sweep, now project-scoped. It is seeded only for the harness
 * project (the mission-control repo onboarded as a project) so a public install
 * no longer spends every user's tokens improving a single repo. The agent turn
 * reads that project's own kernel/README and files harness proposals.
 */
export async function runGuidanceSweep(
  root: string,
  context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = context?.project;
  if (!project) throw new Error("Missing project context.");

  const guidanceContext = await buildGuidanceSweepContext(project.repoPath);
  const prompt = buildGuidanceSweepPrompt(guidanceContext);

  const result = await runAutonomyAgentTurn(root, {
    taskId: `autonomy:project:${project.id}:guidance-sweep`,
    taskTitle: `Guidance sweep: ${project.name}`,
    projectId: project.id,
    repoPath: project.repoPath,
    stateFileName: `${project.id}/guidance-sweep.json`,
    skipSummary: `Guidance sweep skipped for ${project.name}: already running.`,
    completedSummary: (turnNumber, proposalsCreated) =>
      `Guidance sweep turn ${turnNumber} for ${project.name}; filed ${proposalsCreated} proposal(s).`,
    blockedSummary: (reason) => `Guidance sweep blocked for ${project.name}: ${reason}.`,
    buildContext: async () => guidanceContext,
    buildPrompt: () => prompt
  });

  return {
    jobId: "guidance-sweep",
    status: result.status,
    summary: result.summary,
    proposalsCreated: result.proposalsCreated
  };
}
