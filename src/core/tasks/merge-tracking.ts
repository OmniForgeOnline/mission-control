import type { ConnectorVault } from "../../connectors/vault/types.ts";
import {
  describeMergeFailure,
  getMergeRequestState,
  type MergeRequestState,
  type MergeStateFailureReason
} from "../merge-request/status.ts";
import type { HarnessTask, Resolution } from "../types.ts";
import { isMergePending } from "./status.ts";
import { listTasks, updateTask } from "./tasks.ts";

type FetchLike = typeof fetch;

function now(): string {
  return new Date().toISOString();
}

export type MergeRefreshOutcome = "merged" | "open" | "closed" | "unknown" | "skipped";

export interface MergeRefreshResult {
  taskId: string;
  outcome: MergeRefreshOutcome;
  reason?: MergeStateFailureReason;
  detail?: string;
}

export interface MergeRefreshOptions {
  fetchImpl?: FetchLike;
  vault?: ConnectorVault;
}

function outcomeFor(state: MergeRequestState | null): Exclude<MergeRefreshOutcome, "skipped"> {
  if (state === "merged") return "merged";
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  return "unknown";
}

/**
 * Fields that advance a task to completion once its MR/PR has landed. Idempotent:
 * preserves any existing completion timestamp so a re-run never overwrites it.
 */
function withCompletion(current: HarnessTask, completedAt: string): HarnessTask {
  return {
    ...current,
    resolution: "completed" as Resolution,
    completedAt: current.completedAt ?? completedAt
  };
}

/**
 * A task needs merge-state attention when its MR/PR has not been confirmed merged
 * (poll the forge to find out), or has been confirmed merged but has not yet advanced
 * to a terminal resolution (self-heal it to completed). The self-heal covers tasks that
 * another sweep (worktree cleanup) recorded as merged without completing; without it
 * they are no longer merge-pending and would be skipped forever, never receiving
 * persisted completion state.
 */
function mergeStateNeedsAttention(task: HarnessTask): boolean {
  if (!task.mergeRequest) return false;
  if (isMergePending(task)) return true;
  return !task.resolution;
}

/**
 * Self-heal a task whose merge was recorded (mergedAt set) but which never reached
 * completion. Completes it from the recorded merge time without re-polling the forge.
 */
async function completeMergedTask(root: string, task: HarnessTask): Promise<void> {
  await updateTask(root, task.id, (current) => {
    const mergedAt = current.mergeRequest?.mergedAt;
    if (!mergedAt) return current;
    return {
      ...withCompletion(current, mergedAt),
      mergeRequest: { ...current.mergeRequest!, state: "merged" },
      updatedAt: now()
    };
  });
}

/**
 * Refresh a single task's MR/PR merge state against the forge. The task advances to
 * completed only when the host reports the MR/PR as merged; last-known state and
 * check time are recorded otherwise. Closed-without-merge stays unresolved so it keeps
 * surfacing as operator work. A task whose merge another sweep already recorded (but
 * never completed) is self-healed without a forge poll. No-ops for tasks without a
 * merge request.
 */
export async function refreshTaskMergeState(
  root: string,
  task: HarnessTask,
  options?: MergeRefreshOptions
): Promise<MergeRefreshResult> {
  if (!task.mergeRequest) {
    return { taskId: task.id, outcome: "skipped" };
  }

  if (task.mergeRequest.mergedAt && !task.resolution) {
    await completeMergedTask(root, task);
    return { taskId: task.id, outcome: "merged" };
  }

  if (!isMergePending(task) || !task.repoPath) {
    return { taskId: task.id, outcome: "skipped" };
  }

  const { provider, url, number } = task.mergeRequest;

  const result = await getMergeRequestState({
    root,
    repoPath: task.repoPath,
    ...(url !== undefined ? { url } : {}),
    provider,
    number,
    ...(options?.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options?.vault !== undefined ? { vault: options.vault } : {})
  });

  const checkedAt = now();

  if (result.state === null) {
    // No positive evidence either way: record the check time, preserve the last
    // known state and any existing resolution, and surface why we could not tell.
    await updateTask(root, task.id, (current) => {
      const base = current.mergeRequest ?? { provider, url, number };
      return { ...current, mergeRequest: { ...base, checkedAt }, updatedAt: checkedAt };
    });
    return {
      taskId: task.id,
      outcome: "unknown",
      reason: result.reason,
      ...(result.detail !== undefined ? { detail: result.detail } : {})
    };
  }

  const state: MergeRequestState = result.state;
  const outcome = outcomeFor(state);

  await updateTask(root, task.id, (current) => {
    const base = current.mergeRequest ?? { provider, url, number };
    const mergeRequest = { ...base, state, checkedAt };
    if (outcome === "merged") {
      return {
        ...withCompletion(current, checkedAt),
        mergeRequest: { ...mergeRequest, mergedAt: base.mergedAt ?? checkedAt },
        updatedAt: checkedAt
      };
    }
    // Recovery only: terminal handoffs no longer complete a merge-pending task, so a
    // `completed` resolution alongside an open or closed-without-merge MR/PR is stale
    // persisted state (written before that guard, or set by an operator override).
    // Drop it so the ticket resurfaces as operator work; intentional cancellations are
    // preserved. `unknown` is not positive evidence either way, so it must not revoke a
    // completion.
    if ((outcome === "open" || outcome === "closed") && current.resolution === "completed") {
      const { resolution: _stale, completedAt: _staleCompletedAt, ...rest } = current;
      return { ...rest, mergeRequest, updatedAt: checkedAt };
    }
    return { ...current, mergeRequest, updatedAt: checkedAt };
  });

  return { taskId: task.id, outcome };
}

export interface MergeRefreshSummary {
  scanned: number;
  merged: number;
  open: number;
  closed: number;
  unknown: number;
  unknownReasons: string[];
}

/**
 * Refresh merge state for every task with a pending MR/PR, self-healing any task whose
 * merge was recorded but never completed. Accepts an explicit task list so callers
 * (tests, sweeps that already loaded tasks) can avoid a second read.
 */
export async function refreshMergeStates(
  root: string,
  tasks?: HarnessTask[],
  options?: MergeRefreshOptions
): Promise<MergeRefreshSummary> {
  const list = tasks ?? (await listTasks(root));
  const summary: MergeRefreshSummary = { scanned: 0, merged: 0, open: 0, closed: 0, unknown: 0, unknownReasons: [] };

  for (const task of list) {
    if (!mergeStateNeedsAttention(task) || !task.repoPath) continue;
    const result = await refreshTaskMergeState(root, task, options);
    summary.scanned += 1;
    if (result.outcome === "merged") summary.merged += 1;
    else if (result.outcome === "open") summary.open += 1;
    else if (result.outcome === "closed") summary.closed += 1;
    else {
      summary.unknown += 1;
      if (result.reason) {
        summary.unknownReasons.push(describeMergeFailure(result.reason, result.detail));
      }
    }
  }

  return summary;
}
