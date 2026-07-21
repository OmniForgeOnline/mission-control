import type { HarnessTask } from "../types.ts";
import type { TaskMetricsAggregate } from "./types.ts";

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function isAcceptedOutcome(task: HarnessTask): boolean {
  return task.resolution === "completed";
}

export function isCancelledTask(task: HarnessTask): boolean {
  return task.resolution === "cancelled";
}

export function isFailedTask(task: HarnessTask): boolean {
  if (isAcceptedOutcome(task) || isCancelledTask(task)) return false;
  if (task.resolution === "wont_do" || task.resolution === "superseded") return true;
  if (task.completedAt && !isAcceptedOutcome(task)) return true;
  if (task.lastCheckFailure) return true;
  return false;
}

export function isRetriedTask(task: HarnessTask): boolean {
  return countToolRetries(task) > 0;
}

export function isReviewedTask(task: HarnessTask): boolean {
  return (
    (task.reviewRounds ?? 0) > 0 ||
    task.reviewState === "approved" ||
    task.reviewState === "changes_requested"
  );
}

export function countOperatorInterventions(task: HarnessTask): number {
  return task.messages.filter((message) => message.author === "operator").length;
}

export function countToolRetries(task: HarnessTask): number {
  return (task.checkRound ?? 0) + (task.conflictRound ?? 0) + (task.resumeAttempts ?? 0);
}

export function wallTimeMs(task: HarnessTask): number | undefined {
  if (!task.startedAt) return undefined;
  const end = task.completedAt ?? task.updatedAt;
  const ms = Date.parse(end) - Date.parse(task.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function isFirstPassReviewAccepted(task: HarnessTask): boolean {
  return (
    isAcceptedOutcome(task) &&
    task.reviewState === "approved" &&
    (task.reviewRounds ?? 0) === 1
  );
}

export function isDeterministicPass(task: HarnessTask): boolean {
  if (!isAcceptedOutcome(task)) return false;
  return !task.lastCheckFailure;
}

export function aggregateTaskMetrics(tasks: HarnessTask[]): TaskMetricsAggregate {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let retried = 0;
  let reviewed = 0;
  let acceptedOutcome = 0;
  let deterministicPass = 0;
  let firstPassReviewAccepted = 0;
  let withCompletedAtButNotSuccessful = 0;
  let totalOperatorInterventions = 0;
  let totalToolRetries = 0;
  let totalReviewRounds = 0;
  let wallTimeTotalMs = 0;
  let wallTimeCount = 0;

  for (const task of tasks) {
    if (isAcceptedOutcome(task)) completed += 1;
    if (isFailedTask(task)) failed += 1;
    if (isCancelledTask(task)) cancelled += 1;
    if (isRetriedTask(task)) retried += 1;
    if (isReviewedTask(task)) reviewed += 1;
    if (isAcceptedOutcome(task)) acceptedOutcome += 1;
    if (isDeterministicPass(task)) deterministicPass += 1;
    if (isFirstPassReviewAccepted(task)) firstPassReviewAccepted += 1;
    if (task.completedAt && !isAcceptedOutcome(task)) withCompletedAtButNotSuccessful += 1;

    totalOperatorInterventions += countOperatorInterventions(task);
    totalToolRetries += countToolRetries(task);
    totalReviewRounds += task.reviewRounds ?? 0;

    const elapsed = wallTimeMs(task);
    if (elapsed !== undefined) {
      wallTimeTotalMs += elapsed;
      wallTimeCount += 1;
    }
  }

  const total = tasks.length;
  return {
    total,
    completed,
    failed,
    cancelled,
    retried,
    reviewed,
    acceptedOutcome,
    deterministicPass,
    firstPassReviewAccepted,
    withCompletedAtButNotSuccessful,
    rates: {
      acceptedOutcome: rate(acceptedOutcome, total),
      deterministicPass: rate(deterministicPass, total),
      firstPassReviewAccepted: rate(firstPassReviewAccepted, reviewed)
    },
    averages: {
      reviewRounds: total ? totalReviewRounds / total : 0,
      operatorInterventions: total ? totalOperatorInterventions / total : 0,
      toolRetries: total ? totalToolRetries / total : 0,
      wallTimeMs: wallTimeCount ? wallTimeTotalMs / wallTimeCount : null
    },
    usage: {
      inputTokens: "unknown",
      outputTokens: "unknown",
      costUsd: "unknown"
    }
  };
}
