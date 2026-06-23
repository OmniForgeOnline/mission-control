import path from "node:path";

import { readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import { approveTask, createTask, listTasks } from "../../core/tasks/tasks.ts";
import { projectDir } from "../../core/projects/registry.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

interface TechDebtItem {
  id: string;
  title: string;
  description: string;
  agent?: "codex" | "claude";
  targets?: Array<{ raw: string; path: string; kind: "file" | "directory" }>;
  status?: "open" | "closed" | "queued";
  queuedTaskId?: string;
}

export async function runProjectTechDebtSweep(
  root: string,
  context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = context?.project;
  if (!project) throw new Error("Missing project context.");

  const debtPath = path.join(projectDir(root, project.id), "tech-debt.json");
  const items = await readJsonFile<TechDebtItem[]>(debtPath, []);
  const open = items.find((item) => (item.status ?? "open") === "open");
  if (!open) {
    return {
      jobId: "tech-debt-sweep",
      status: "completed",
      summary: `No open tech-debt items in ${project.name}.`,
      proposalsCreated: 0
    };
  }

  const tasks = await listTasks(root);
  if (open.queuedTaskId && tasks.some((t) => t.id === open.queuedTaskId)) {
    return {
      jobId: "tech-debt-sweep",
      status: "completed",
      summary: `Tech-debt item ${open.id} in ${project.name} already queued.`,
      proposalsCreated: 0
    };
  }

  const created = await createTask(root, {
    title: `Tech debt (${project.name}): ${open.title}`,
    description: open.description,
    agent: open.agent ?? "claude",
    source: "autonomy",
    links: [],
    projectId: project.id,
    repoPath: project.repoPath,
    ...(open.targets !== undefined ? { targets: open.targets } : {})
  });
  await approveTask(root, created.id);

  const next = items.map((item) =>
    item.id === open.id ? { ...item, status: "queued" as const, queuedTaskId: created.id } : item
  );
  await writeJsonFile(debtPath, next);

  return {
    jobId: "tech-debt-sweep",
    status: "completed",
    summary: `Queued synthetic task for ${open.id} in ${project.name}.`,
    proposalsCreated: 0,
    syntheticTaskId: created.id
  };
}
