import { readProjectQualityGateRun } from "../../core/projects/quality-gate.ts";
import { approveTask, createTask, listTasks } from "../../core/tasks/tasks.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

const QUALITY_GATE_TASK_PREFIX = "Quality gate:";
const titleFor = (checkName: string): string => `${QUALITY_GATE_TASK_PREFIX} ${checkName}`;

/**
 * Sweep the last full quality-gate run and queue a synthetic remediation task for
 * each FAILING check that doesn't already have an active task.
 *
 * This replaced a grade-driven sweep (which acted on a heuristic A-F letter). It
 * now acts on a real verification outcome — a check that failed when the gate ran.
 * It reads the persisted last run (`quality-gate-run.json`, written by the gate's
 * "Run all"); if no run exists yet it no-ops rather than inventing work. Dedup keys
 * on the check name + an unresolved task scoped to the project's repo, so a failing
 * check that already has an open task isn't filed twice.
 */
export async function runProjectQualityGateSweep(
  root: string,
  context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = context?.project;
  if (!project) throw new Error("Missing project context.");

  const run = await readProjectQualityGateRun(root, project.id);
  if (!run) {
    return {
      jobId: "quality-gate-sweep",
      status: "completed",
      summary: `No quality-gate run on record for ${project.name}. Run the gate (project Quality tab → Run) before sweeping.`,
      proposalsCreated: 0
    };
  }

  const failed = run.results.filter((r) => r.status === "failed");
  if (failed.length === 0) {
    return {
      jobId: "quality-gate-sweep",
      status: "completed",
      summary: `Quality gate passed for ${project.name} (last run ${run.runAt}). Nothing to remediate.`,
      proposalsCreated: 0
    };
  }

  const tasks = await listTasks(root);
  const targets = failed.filter((check) => {
    const title = titleFor(check.name);
    return !tasks.some(
      (t) =>
        t.title === title &&
        !t.resolution &&
        t.targets.some((tgt) => tgt.path.startsWith(project.repoPath))
    );
  });

  if (targets.length === 0) {
    return {
      jobId: "quality-gate-sweep",
      status: "completed",
      summary: `${failed.length} failing check(s) for ${project.name} already have active tasks.`,
      proposalsCreated: 0
    };
  }

  const createdIds: string[] = [];
  const summaries: string[] = [];
  for (const check of targets) {
    // ponytail: cap the output at 1k chars — the full output lives in the run log.
    const outputSnippet = check.output.slice(0, 1000);
    const description = [
      `The \`${check.name}\` quality-gate check is failing.`,
      "",
      `Command: \`${check.command}\``,
      `Exit code: ${check.exitCode}`,
      "",
      "Last run output (truncated):",
      outputSnippet,
      "",
      "Fix the check so the gate passes. Run the command locally first to confirm.",
      `Last gate run: ${run.runAt}.`
    ].join("\n");

    const created = await createTask(root, {
      title: titleFor(check.name),
      description,
      agent: "claude",
      source: "autonomy",
      links: [],
      projectId: project.id,
      repoPath: project.repoPath,
      targets: [{ raw: `@${project.repoPath}`, path: project.repoPath, kind: "directory" }]
    });
    await approveTask(root, created.id);
    createdIds.push(created.id);
    summaries.push(check.name);
  }

  const countLabel = summaries.length === 1 ? "1 failing check" : `${summaries.length} failing checks`;
  return {
    jobId: "quality-gate-sweep",
    status: "completed",
    summary: `Quality-gate sweep for ${project.name}: ${countLabel} queued (${summaries.join(", ")}).`,
    proposalsCreated: 0,
    ...(createdIds[0] !== undefined ? { syntheticTaskId: createdIds[0] } : {})
  };
}
