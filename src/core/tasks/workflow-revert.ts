import crypto from "node:crypto";

import { updateTask, getTask } from "./tasks.ts";
import { EntityNotFoundError } from "./errors.ts";
import { requireAttachments } from "../attachments/store.ts";
import {
  canRevertToStep,
  downstreamStepIds,
  loadWorkflow,
  rewindWorkflowRunForRevert
} from "../workflows/index.ts";
import type { WorkflowDefinition } from "../workflows/index.ts";
import type { HarnessMessage, HarnessTask } from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

/**
 * Step kinds whose outputs become stale when the workflow re-runs from
 * `targetStepId`: the target itself (it is re-run) plus every downstream step.
 */
function affectedStepKinds(workflow: WorkflowDefinition, targetStepId: string): Set<string> {
  const kinds = new Set<string>();
  for (const id of [targetStepId, ...downstreamStepIds(workflow, targetStepId)]) {
    const kind = workflow.steps[id]?.kind;
    if (kind) kinds.add(kind);
  }
  return kinds;
}

/**
 * Task-level fields to discard on revert, scoped to the kinds that produced them
 * so a revert never throws away inputs the reopened step still needs (e.g. a
 * revert to `review` keeps the pushed branch and merge request it inspects).
 */
function revertClearKeys(kinds: Set<string>): Array<keyof HarnessTask> {
  const keys: Array<keyof HarnessTask> = [
    // Execution state is reset on any explicit operator resume.
    "blockedReason",
    "pausedAt",
    "interruptedAt",
    "currentActivity",
    "lastProgressAt",
    // The reopened step gets a fresh resume budget.
    "resumeAttempts",
    "resumeAttemptsStepId"
  ];

  if (kinds.has("terminal")) {
    keys.push("resolution", "completedAt");
  }
  if (kinds.has("create_merge_request")) {
    keys.push("mergeRequest");
  }
  if (kinds.has("review")) {
    keys.push("reviewState", "reviewRounds");
  }
  if (kinds.has("agent_turn") || kinds.has("conversation")) {
    // Author/planning sessions and repo-push artifacts regenerate on re-run.
    keys.push(
      "pushedAt",
      "commitCount",
      "agentSessionId",
      "agentSessionAgent",
      "agentSessionModelPool",
      "agentSessionConversation",
      // Inline check remediation state is owned by the author turn that produced it.
      "checkRound",
      "lastCheckFailure",
      "remediationStreak",
      "lastRemediationFingerprint"
    );
  }

  return keys;
}

function omitKeys(task: HarnessTask, keys: Array<keyof HarnessTask>): HarnessTask {
  const next = { ...task };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

export interface RevertTaskOptions {
  /** Operator directive applied as the reopened step's fresh input. */
  message?: string;
  /** Operator-uploaded attachments carried onto the recorded revert message. */
  attachmentIds?: string[];
}

/**
 * Rewind `task` to `stepId`, discarding downstream progress and artifacts, then
 * (optionally) record an operator message scoped to that step. The target step's
 * own approval is retained by the run rewind, so a revert-and-resume runs it
 * immediately. Returns the persisted task positioned on the target step.
 */
export async function revertTaskToWorkflowStep(
  root: string,
  taskId: string,
  stepId: string,
  options?: RevertTaskOptions
): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task) throw new EntityNotFoundError("task", taskId);
  if (!task.workflowRun) throw new Error(`Task ${taskId} has no workflow run.`);

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  if (!canRevertToStep(workflow, task, stepId)) {
    throw new Error(
      `Cannot revert to step "${stepId}" (unknown, terminal, or forward of the current step).`
    );
  }

  const rewoundRun = rewindWorkflowRunForRevert(workflow, task.workflowRun, stepId);
  const downstreamIds = new Set(downstreamStepIds(workflow, stepId));
  const clearKeys = revertClearKeys(affectedStepKinds(workflow, stepId));
  const undidCompletion = clearKeys.includes("resolution");
  const messageBody = options?.message?.trim();
  const attachments = options?.attachmentIds?.length
    ? await requireAttachments(root, options.attachmentIds)
    : [];

  return updateTask(root, taskId, (current) => {
    const cleared = omitKeys(current, clearKeys);
    const clearedOverride =
      undidCompletion && cleared.statusOverride?.value === "done"
        ? omitKeys(cleared, ["statusOverride"])
        : cleared;
    const timestamp = now();
    // Discard conversation/turn outputs produced by steps that will be replayed
    // so the reopened step sees a clean slate; target and ancestor messages stay.
    const survivingMessages = (current.messages ?? []).filter(
      (entry) => !(entry.stepId && downstreamIds.has(entry.stepId))
    );
    const message: HarnessMessage | null = messageBody
      ? {
          id: crypto.randomUUID(),
          author: "operator",
          body: messageBody,
          createdAt: timestamp,
          stepId,
          ...(attachments.length ? { attachments } : {})
        }
      : null;

    return {
      ...clearedOverride,
      workflowRun: rewoundRun,
      messages: message ? [...survivingMessages, message] : survivingMessages,
      updatedAt: timestamp
    };
  });
}
