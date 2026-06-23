import { taskExecution, taskPmStatus, uiLegacyStatus } from "@ui/app/task-status.js";
import type { HarnessTask, PmStatus } from "@ui/app/types.js";

export type TaskFilter =
  | "all"
  | "running"
  | "awaiting"
  | "blocked"
  | "queue"
  | "resumable"
  | "done";

const TASK_FILTERS = new Set<TaskFilter>([
  "all",
  "running",
  "awaiting",
  "blocked",
  "queue",
  "resumable",
  "done"
]);

const PM_SECTIONS: Array<{ key: PmStatus; title: string }> = [
  { key: "backlog", title: "Backlog" },
  { key: "in_progress", title: "In Progress" },
  { key: "in_review", title: "In Review" },
  { key: "done", title: "Done" }
];

export function isTaskFilter(value: string): value is TaskFilter {
  return TASK_FILTERS.has(value as TaskFilter);
}

export function parseTaskFilter(value: string | null | undefined): TaskFilter {
  if (value && isTaskFilter(value)) return value;
  return "all";
}

export interface TaskSection {
  key: string;
  title: string;
  tasks: HarnessTask[];
  defaultOpen?: boolean;
}

export interface TaskBucketCounts {
  all: number;
  running: number;
  awaiting: number;
  blocked: number;
  queue: number;
  resumable: number;
  done: number;
}

export function countTaskBuckets(tasks: HarnessTask[]): TaskBucketCounts {
  const running = tasks.filter((t) => uiLegacyStatus(t) === "running");
  const awaiting = tasks.filter((t) => {
    const status = uiLegacyStatus(t);
    return status === "awaiting_operator" || status === "awaiting_review";
  });
  const queue = tasks.filter((t) => {
    const status = uiLegacyStatus(t);
    return status === "queued" || status === "approved";
  });
  const resumable = tasks.filter((t) => {
    const status = uiLegacyStatus(t);
    return status === "paused" || status === "interrupted";
  });
  const done = tasks.filter((t) => ["completed", "blocked", "cancelled"].includes(uiLegacyStatus(t)));

  return {
    all: tasks.length,
    running: running.length,
    awaiting: awaiting.length,
    blocked: done.filter((t) => uiLegacyStatus(t) === "blocked").length,
    queue: queue.length,
    resumable: resumable.length,
    done: done.length
  };
}

function bucketByPmStatus(tasks: HarnessTask[]): TaskSection[] {
  return PM_SECTIONS.map((section) => ({
    key: section.key,
    title: section.title,
    tasks: tasks.filter((task) => taskPmStatus(task) === section.key),
    defaultOpen: section.key !== "done"
  })).filter((section) => section.tasks.length > 0);
}

export function bucketTasks(tasks: HarnessTask[], filter: TaskFilter): TaskSection[] {
  if (filter === "all") {
    return bucketByPmStatus(tasks);
  }

  const running = tasks.filter((t) => uiLegacyStatus(t) === "running");
  const awaiting = tasks.filter((t) => {
    const status = uiLegacyStatus(t);
    return status === "awaiting_operator" || status === "awaiting_review";
  });
  const queue = tasks.filter((t) => {
    const status = uiLegacyStatus(t);
    return status === "queued" || status === "approved";
  });
  const resumable = tasks.filter((t) => {
    const status = uiLegacyStatus(t);
    return status === "paused" || status === "interrupted";
  });
  const done = tasks.filter((t) => ["completed", "blocked", "cancelled"].includes(uiLegacyStatus(t)));

  const sections: TaskSection[] = [];
  if (filter === "running") {
    sections.push({ key: "running", title: "Active", tasks: running, defaultOpen: true });
  }
  if (filter === "awaiting") {
    sections.push({ key: "awaiting", title: "Awaiting reply", tasks: awaiting, defaultOpen: true });
  }
  if (filter === "queue") {
    sections.push({ key: "queue", title: "Queue", tasks: queue, defaultOpen: true });
  }
  if (filter === "resumable") {
    if (resumable.length > 0) {
      sections.push({ key: "resumable", title: "Resumable", tasks: resumable, defaultOpen: true });
    }
  }
  if (filter === "blocked") {
    const blocked = done.filter((t) => uiLegacyStatus(t) === "blocked");
    if (blocked.length > 0) {
      sections.push({ key: "blocked", title: "Blocked", tasks: blocked, defaultOpen: true });
    }
  }
  if (filter === "done") {
    sections.push({ key: "done", title: "Done", tasks: done, defaultOpen: true });
  }

  return sections;
}

export function executionBadgeLabel(task: HarnessTask): string | null {
  const execution = taskExecution(task);
  const parallel = task.workflowRun?.activeStepIds?.length ?? 0;
  if (execution === "running" && parallel > 1) {
    return `running · ${parallel} jobs`;
  }
  if (execution === "idle") return null;
  return execution;
}