import { liveness } from "@ui/app/state.js";
import { isMergePending, uiLegacyStatus } from "@ui/app/task-status.js";
import type { TaskFilter } from "@ui/features/tasks/filters.js";
import type { HarnessTask } from "@ui/app/types.js";

export type AttentionSectionId =
  | "merge"
  | "awaiting"
  | "blocked"
  | "stalled"
  | "resumable"
  | "running";

export interface AttentionSection {
  id: AttentionSectionId;
  title: string;
  /** App-bar pill filter that should scroll/focus this section. */
  filters: TaskFilter[];
  tasks: HarnessTask[];
}

/**
 * Merge-pending tickets, closed-without-merge first (needs operator action), then
 * recency. Powers the "Needs merge" section of the homepage.
 */
export function awaitingMergeTasks(tasks: HarnessTask[]): HarnessTask[] {
  return tasks
    .filter(isMergePending)
    .sort((a, b) => {
      const aClosed = a.mergeRequest?.state === "closed" ? 0 : 1;
      const bClosed = b.mergeRequest?.state === "closed" ? 0 : 1;
      if (aClosed !== bClosed) return aClosed - bClosed;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
}

/** Tone for an awaiting-merge row: closed-without-merge needs operator action most. */
export function mergeAttentionState(task: HarnessTask): { label: string; tone: "open" | "closed" } {
  if (task.mergeRequest?.state === "closed") {
    return { label: "Closed without merge", tone: "closed" };
  }
  return { label: "Awaiting merge", tone: "open" };
}

function byUpdatedDesc(a: HarnessTask, b: HarnessTask): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/**
 * Cross-project attention buckets for Home. A task appears in at most one
 * section (priority: merge → blocked → stalled → awaiting → resumable → running).
 */
export function attentionSections(tasks: HarnessTask[]): AttentionSection[] {
  const merge = awaitingMergeTasks(tasks);
  const claimed = new Set(merge.map((task) => task.id));

  const take = (predicate: (task: HarnessTask) => boolean): HarnessTask[] =>
    tasks.filter((task) => !claimed.has(task.id) && predicate(task)).sort(byUpdatedDesc);

  const blocked = take((task) => uiLegacyStatus(task) === "blocked");
  for (const task of blocked) claimed.add(task.id);

  const stalled = take((task) => {
    const live = liveness(task);
    return Boolean(live?.warn);
  });
  for (const task of stalled) claimed.add(task.id);

  const awaiting = take((task) => {
    const status = uiLegacyStatus(task);
    return status === "awaiting_operator" || status === "awaiting_review";
  });
  for (const task of awaiting) claimed.add(task.id);

  const resumable = take((task) => {
    const status = uiLegacyStatus(task);
    return status === "paused" || status === "interrupted";
  });
  for (const task of resumable) claimed.add(task.id);

  const running = take((task) => uiLegacyStatus(task) === "running");

  const sections: AttentionSection[] = [
    {
      id: "merge",
      title: "Needs merge",
      filters: ["awaiting"],
      tasks: merge
    },
    {
      id: "awaiting",
      title: "Awaiting reply",
      filters: ["awaiting"],
      tasks: awaiting
    },
    {
      id: "blocked",
      title: "Blocked",
      filters: ["blocked"],
      tasks: blocked
    },
    {
      id: "stalled",
      title: "Stalled / long-running",
      filters: ["running"],
      tasks: stalled
    },
    {
      id: "resumable",
      title: "Resumable",
      filters: ["resumable"],
      tasks: resumable
    },
    {
      id: "running",
      title: "Running",
      filters: ["running"],
      tasks: running
    }
  ];
  return sections.filter((section) => section.tasks.length > 0);
}

/** Section ids that should be emphasized for a given app-bar filter. */
export function attentionFocusIds(filter: TaskFilter): Set<AttentionSectionId> {
  switch (filter) {
    case "awaiting":
      return new Set(["merge", "awaiting"]);
    case "blocked":
      return new Set(["blocked"]);
    case "running":
      return new Set(["stalled", "running"]);
    case "resumable":
      return new Set(["resumable"]);
    default:
      return new Set();
  }
}
