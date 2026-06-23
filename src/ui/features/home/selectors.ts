import { isMergePending } from "@ui/app/task-status.js";
import type { HarnessTask } from "@ui/app/types.js";

/**
 * Merge-pending tickets, closed-without-merge first (needs operator action), then
 * recency. Powers the "awaiting review & merge" section of the homepage.
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
