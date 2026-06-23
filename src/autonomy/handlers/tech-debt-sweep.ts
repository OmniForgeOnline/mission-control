import { readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import { approveTask, createTask, listTasks } from "../../core/tasks/tasks.ts";
import type { AutonomyRunResult } from "../job-types.ts";
import { techDebtPath } from "../job-types.ts";

interface TechDebtItem {
  id: string;
  title: string;
  description: string;
  agent?: "codex" | "claude";
  targets?: Array<{ raw: string; path: string; kind: "file" | "directory" }>;
  status?: "open" | "closed" | "queued";
  queuedTaskId?: string;
}

export async function runTechDebtSweep(root: string): Promise<AutonomyRunResult> {
  const items = await readJsonFile<TechDebtItem[]>(techDebtPath(root), []);
  const open = items.find((item) => (item.status ?? "open") === "open");
  if (!open) {
    return { jobId: "tech-debt-sweep", status: "completed", summary: "No open tech-debt items.", proposalsCreated: 0 };
  }
  const tasks = await listTasks(root);
  if (open.queuedTaskId && tasks.some((t) => t.id === open.queuedTaskId)) {
    return { jobId: "tech-debt-sweep", status: "completed", summary: `Tech-debt item ${open.id} already queued.`, proposalsCreated: 0 };
  }
  const created = await createTask(root, {
    title: `Tech debt: ${open.title}`,
    description: open.description,
    agent: open.agent ?? "claude",
    source: "autonomy",
    links: [],
    ...(open.targets !== undefined ? { targets: open.targets } : {})
  });
  await approveTask(root, created.id);
  const next = items.map((item) =>
    item.id === open.id ? { ...item, status: "queued" as const, queuedTaskId: created.id } : item
  );
  await writeJsonFile(techDebtPath(root), next);
  return { jobId: "tech-debt-sweep", status: "completed", summary: `Queued synthetic task for ${open.id}.`, proposalsCreated: 0, syntheticTaskId: created.id };
}