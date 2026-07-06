import crypto from "node:crypto";
import path from "node:path";

import { prepareDescriptionForMarkdown, sanitizeAgentMessageBody } from "../agents/output.ts";
import { readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { spreadDefined } from "../infra/record.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import { extractTargets, homeRootForHarness } from "../paths/targets.ts";
import { resolveTargetsForGitWorkflow } from "./repo-binding.ts";
import { clearAgentSession } from "../agents/session.ts";
import { isRegisteredAgent, unregisteredAgentMessage } from "../agents/stage-agents.ts";
import { canApprovePlan, extractPlanFromTask } from "../prompts/plan-approval.ts";
import { canRefinePlan, rewindWorkflowForPlanRefinement } from "../prompts/plan-refinement.ts";
import {
  advanceWorkflowStep,
  createWorkflowRun,
  fastForwardToImplementStep,
  getCurrentStep,
  markStepApproved,
  normalizeTaskWorkflowRun,
  routeWorkflowToImplementation,
  routeWorkflowToMergeRequest
} from "../workflows/run.ts";
import {
  applyOverrideClearing,
  isAwaitingOperator,
  migrateLegacyTaskStatus
} from "./status.ts";
import { loadHarnessSettings } from "../settings.ts";
import {
  assertValidWorkflowStep,
  DEFAULT_WORKFLOW_ID,
  findImplementationStepId,
  loadAllWorkflows,
  loadWorkflow,
  stepSupportsEffort
} from "../workflows/index.ts";
import { captureFromOperatorMessage, captureProjectContextFromTask } from "../../memory/auto-capture.ts";
import { requireAttachments } from "../attachments/store.ts";
import { normalizeLegacyProposalTicket } from "../proposals/ticket.ts";
import {
  emitStateChange,
  taskActivityScope,
  taskMessagesScope,
  taskScopes,
  type StateScope
} from "../infra/state-bus.ts";
import type {
  ToolId,
  CreateTaskInput,
  EffortLevel,
  HarnessMessage,
  HarnessTask,
  PmStatus,
  Resolution,
  TaskStatus
} from "../types.ts";
import { isEffortLevel } from "../types.ts";
import { isMergePending, isTaskRunning } from "./status.ts";

function tasksPath(root: string): string {
  return path.join(root, "data", "state", "tasks.json");
}

function now(): string {
  return new Date().toISOString();
}

function repairTaskContent(task: HarnessTask): { task: HarnessTask; changed: boolean } {
  const description = task.description
    ? prepareDescriptionForMarkdown(task.description)
    : task.description;
  const messages = task.messages
    ?.map((message) => {
      const body = sanitizeAgentMessageBody(message.body).trim();
      return body === message.body ? message : { ...message, body };
    })
    .filter((message) => message.body.length > 0);
  const descriptionChanged = description !== task.description;
  const messagesChanged =
    (messages?.length ?? 0) !== (task.messages?.length ?? 0) ||
    (messages?.some((m, i) => m.body !== task.messages?.[i]?.body) ?? false);
  if (!descriptionChanged && !messagesChanged) {
    return { task, changed: false };
  }
  return {
    task: {
      ...task,
      ...(descriptionChanged ? { description } : {}),
      ...(messagesChanged ? { messages } : {})
    },
    changed: true
  };
}

async function normalizeTasks(tasks: HarnessTask[], root: string): Promise<HarnessTask[]> {
  const workflows = await loadAllWorkflows(root);
  let changed = false;
  const normalized = tasks.map((task) => {
    const legacy = normalizeLegacyProposalTicket(task);
    if (legacy.changed) changed = true;
    const withWorkflow = migrateLegacyTaskStatus(normalizeTaskWorkflowRun(legacy.task, workflows));
    const repaired = repairTaskContent(withWorkflow);
    if (repaired.changed) changed = true;
    return repaired.task;
  });
  if (changed) {
    await writeJsonFile(tasksPath(root), normalized);
  }
  return normalized;
}

export async function listTasks(root: string): Promise<HarnessTask[]> {
  await ensureHarnessRepository(root);
  const tasks = await readJsonFile<HarnessTask[]>(tasksPath(root), []);
  return normalizeTasks(tasks, root);
}

export async function getTask(root: string, taskId: string): Promise<HarnessTask | undefined> {
  const tasks = await listTasks(root);
  return tasks.find((task) => task.id === taskId);
}

/** Backfill targets from description paths when intake omitted @-tags. */
export async function rehydrateTaskTargets(root: string, task: HarnessTask): Promise<HarnessTask> {
  if (task.targets.length > 0) return task;

  const homeRoot = homeRootForHarness(root);
  const extracted = await extractTargets(`${task.title}\n${task.description}`, {
    ...(homeRoot !== undefined ? { homeRoot } : {})
  });
  if (extracted.length === 0) return task;

  return updateTask(root, task.id, (current) => ({
    ...current,
    targets: extracted,
    updatedAt: now()
  }));
}

export async function createTask(root: string, input: CreateTaskInput): Promise<HarnessTask> {
  const tasks = await listTasks(root);
  const timestamp = now();
  const workflowId = input.workflowId?.trim() || DEFAULT_WORKFLOW_ID;
  const [workflow, settings] = await Promise.all([loadWorkflow(root, workflowId), loadHarnessSettings(root)]);
  const homeRoot = homeRootForHarness(root);
  const extractedTargets = await extractTargets(`${input.title}\n${input.description}`, {
    ...(homeRoot !== undefined ? { homeRoot } : {})
  });
  const resolvedTargets = await resolveTargetsForGitWorkflow(root, workflow, extractedTargets);
  const workflowRun = createWorkflowRun(workflow);
  const attachments = input.attachmentIds?.length
    ? await requireAttachments(root, input.attachmentIds)
    : [];
  const task: HarnessTask = {
    id: crypto.randomUUID(),
    title: input.title.trim(),
    description: input.description.trim(),
    agent: settings.defaultAgent,
    source: input.source,
    links: input.links ?? [],
    targets: input.targets ?? resolvedTargets,
    messages: [],
    ...(attachments.length ? { attachments } : {}),
    workflowRun,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...spreadDefined({ projectId: input.projectId, repoPath: input.repoPath }),
    ...(input.effort !== undefined ? { effort: input.effort } : {})
  };

  if (!task.title || !task.description) {
    throw new Error("Task title and description are required.");
  }

  await writeJsonFile(tasksPath(root), [task, ...tasks]);
  emitStateChange(taskScopes(task.id));
  void captureProjectContextFromTask(root, task).catch(() => {});
  return task;
}

export async function addTaskMessage(
  root: string,
  taskId: string,
  input: Pick<HarnessMessage, "author" | "body" | "stepId"> & { attachmentIds?: string[] }
): Promise<HarnessMessage> {
  const attachments = input.attachmentIds?.length
    ? await requireAttachments(root, input.attachmentIds)
    : [];
  const message: HarnessMessage = {
    id: crypto.randomUUID(),
    author: input.author,
    body: input.body.trim(),
    createdAt: now(),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(attachments.length ? { attachments } : {})
  };
  if (!message.body) {
    throw new Error("Message body is required.");
  }
  await updateTask(root, taskId, (task) => ({
    ...task,
    messages: [...(task.messages ?? []), message],
    updatedAt: now()
  }), { scopes: [...taskScopes(taskId), taskMessagesScope(taskId)] });
  if (message.author === "operator") {
    const task = await getTask(root, taskId);
    if (task) void captureFromOperatorMessage(root, task, message.body).catch(() => {});
  }
  return message;
}

export async function approveTask(root: string, taskId: string): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (!task.workflowRun) throw new Error(`Task ${taskId} has no workflow run.`);

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  const step = getCurrentStep(workflow, task.workflowRun);
  const workflowRun =
    step.approval === "required" ? markStepApproved(task.workflowRun, step.id) : task.workflowRun;
  const timestamp = now();
  return updateTask(root, taskId, (current) =>
    applyOverrideClearing(
      {
        ...current,
        workflowRun,
        approvedAt: current.approvedAt ?? timestamp,
        updatedAt: timestamp
      },
      workflow
    )
  );
}

export async function preparePlanRefinementTurn(root: string, taskId: string): Promise<HarnessTask | null> {
  const task = await getTask(root, taskId);
  if (!task?.workflowRun) return null;

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  if (!canRefinePlan(task, workflow)) return null;

  const step = getCurrentStep(workflow, task.workflowRun);
  if (isAwaitingOperator(task, workflow) && step.kind === "conversation") {
    return task;
  }

  const rewound = rewindWorkflowForPlanRefinement(workflow, task.workflowRun);
  if (!rewound) return null;

  return updateTask(root, taskId, (current) => ({
    ...current,
    workflowRun: rewound,
    updatedAt: now()
  }));
}

export async function approvePlanForImplementation(root: string, taskId: string): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task?.workflowRun) throw new Error(`Task not found: ${taskId}`);

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  if (!canApprovePlan(task, workflow)) {
    throw new Error("Task is not on a planning step with a plan ready for approval.");
  }

  const implementationStepId = findImplementationStepId(workflow);
  const forwarded = fastForwardToImplementStep(workflow, task.workflowRun);
  if (!forwarded || !implementationStepId || forwarded.currentStepId !== implementationStepId) {
    throw new Error("Could not advance workflow to the implementation step.");
  }

  const timestamp = now();
  const systemMessage: HarnessMessage = {
    id: crypto.randomUUID(),
    author: "system",
    body: "Operator approved the plan. Starting implementation.",
    createdAt: timestamp
  };

  const planText = extractPlanFromTask(task);
  const descriptionWithPlan =
    task.description?.includes("## Plan") || !planText
      ? task.description
      : `${task.description}\n\n## Plan\n\n${planText}`;

  return updateTask(root, taskId, (current) =>
    applyOverrideClearing(
      {
        ...current,
        description: descriptionWithPlan,
        workflowRun: forwarded,
        messages: [...(current.messages ?? []), systemMessage],
        ...clearAgentSession(),
        updatedAt: timestamp
      },
      workflow
    )
  );
}

export async function advanceTaskWorkflowStep(
  root: string,
  taskId: string,
  branch?: string,
  completedStepId?: string
): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task?.workflowRun) throw new Error(`Task not found: ${taskId}`);

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  let { run, done } = advanceWorkflowStep(workflow, task.workflowRun, branch, completedStepId);
  if (!done) {
    const landedStep = getCurrentStep(workflow, run);
    if (landedStep.kind === "terminal") {
      const terminal = advanceWorkflowStep(workflow, run, branch, landedStep.id);
      run = terminal.run;
      done = terminal.done;
    }
  }
  const nextStep = getCurrentStep(workflow, run);
  const currentStep = getCurrentStep(workflow, task.workflowRun);
  const needsBranch =
    !branch &&
    currentStep.branch &&
    !currentStep.next &&
    currentStep.kind !== "terminal";

  if (needsBranch) {
    return updateTask(root, taskId, (current) =>
      applyOverrideClearing({ ...current, workflowRun: run, updatedAt: now() }, workflow)
    );
  }

  const terminal = done || nextStep.kind === "terminal";

  return updateTask(root, taskId, (current) => {
    // A task whose MR/PR has not landed yet is awaiting human review/merge on the
    // forge. Reaching the terminal step must not mark it completed; the merge-status
    // sweep advances it to done once the host reports the MR/PR as merged.
    const completes = terminal && !isMergePending(current);
    const completedAt = completes ? now() : current.completedAt;
    return applyOverrideClearing(
      {
        ...current,
        workflowRun: run,
        ...(completes ? { resolution: "completed" as Resolution, completedAt } : {}),
        updatedAt: now()
      },
      workflow
    );
  });
}

export async function routeTaskToImplementationStep(
  root: string,
  taskId: string,
  branch?: "changes_requested"
): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task?.workflowRun) throw new Error(`Task not found: ${taskId}`);

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  const nextRun = routeWorkflowToImplementation(workflow, task.workflowRun, branch);

  return updateTask(root, taskId, (current) => {
    const {
      completedAt: _completedAt,
      blockedReason: _blockedReason,
      commitCount: _commitCount,
      pushedAt: _pushedAt,
      resolution: _resolution,
      ...rest
    } = current;
    return applyOverrideClearing({ ...rest, workflowRun: nextRun, updatedAt: now() }, workflow);
  });
}

/**
 * Reopen the create_merge_request step so its handler re-runs. Self-heals a task
 * that reached `review` without persisted merge-request metadata, where resuming
 * the review step alone can never satisfy the merge-request precondition.
 */
export async function routeTaskToMergeRequestStep(
  root: string,
  taskId: string
): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task?.workflowRun) throw new Error(`Task not found: ${taskId}`);

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  const nextRun = routeWorkflowToMergeRequest(workflow, task.workflowRun);
  if (!nextRun) {
    throw new Error(`Workflow ${workflow.id} has no create_merge_request step.`);
  }

  return updateTask(root, taskId, (current) => {
    const {
      completedAt: _completedAt,
      blockedReason: _blockedReason,
      resolution: _resolution,
      ...rest
    } = current;
    return applyOverrideClearing({ ...rest, workflowRun: nextRun, updatedAt: now() }, workflow);
  });
}

export async function requeueTask(root: string, taskId: string): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const workflowId = task.workflowRun?.workflowId ?? DEFAULT_WORKFLOW_ID;
  const workflow = await loadWorkflow(root, workflowId);
  const workflowRun = createWorkflowRun(workflow);
  return updateTask(root, taskId, (current) => {
    const {
      approvedAt: _approvedAt,
      startedAt: _startedAt,
      completedAt: _completedAt,
      blockedReason: _blockedReason,
      runId: _runId,
      reviewState: _reviewState,
      workspacePath: _workspacePath,
      repoPath: _repoPath,
      branch: _branch,
      worktreeCleanedAt: _worktreeCleanedAt,
      ...rest
    } = current;
    return {
      ...rest,
      workflowRun,
      turnCount: 0,
      reviewRounds: 0,
      updatedAt: now()
    };
  });
}

export async function updateTaskFields(
  root: string,
  taskId: string,
  updates: Partial<Pick<HarnessTask, "title" | "description" | "agent" | "effort" | "statusOverride">>
): Promise<HarnessTask> {
  return updateTask(root, taskId, (task) => {
    if (isTaskRunning(task)) {
      throw new Error("Cannot edit a running task. Stop it first.");
    }
    if (updates.agent !== undefined) {
      throw new Error(
        "Per-task agent is no longer supported. Configure agents per workflow step instead."
      );
    }
    return {
      ...task,
      ...updates,
      title: updates.title?.trim() || task.title,
      description: updates.description?.trim() || task.description,
      updatedAt: now()
    };
  });
}

function omitTaskKeys(task: HarnessTask, keys: Array<keyof HarnessTask>): HarnessTask {
  const next = { ...task };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

export interface TaskExecutionPatch {
  blockedReason?: string | null;
  pausedAt?: string | null;
  interruptedAt?: string | null;
  resolution?: Resolution | null;
  completedAt?: string | null;
  runId?: string | null;
}

export async function patchTaskExecution(
  root: string,
  taskId: string,
  patch: TaskExecutionPatch,
  updates: Partial<HarnessTask> = {},
  options?: { clear?: Array<keyof HarnessTask> }
): Promise<HarnessTask> {
  const updated = await updateTask(root, taskId, (task) => {
    const merged: HarnessTask = {
      ...omitTaskKeys(task, options?.clear ?? []),
      ...spreadDefined(updates as Record<string, unknown>),
      updatedAt: now()
    };
    if (patch.blockedReason === null) delete merged.blockedReason;
    else if (patch.blockedReason !== undefined) merged.blockedReason = patch.blockedReason;
    if (patch.pausedAt === null) delete merged.pausedAt;
    else if (patch.pausedAt !== undefined) merged.pausedAt = patch.pausedAt;
    if (patch.interruptedAt === null) delete merged.interruptedAt;
    else if (patch.interruptedAt !== undefined) merged.interruptedAt = patch.interruptedAt;
    if (patch.resolution === null) delete merged.resolution;
    else if (patch.resolution !== undefined) merged.resolution = patch.resolution;
    if (patch.completedAt === null) delete merged.completedAt;
    else if (patch.completedAt !== undefined) merged.completedAt = patch.completedAt;
    if (patch.runId === null) delete merged.runId;
    else if (patch.runId !== undefined) merged.runId = patch.runId;
    return merged;
  });
  if (updated.blockedReason) {
    const { captureOperationalError } = await import("../operations/error-ledger.ts");
    void captureOperationalError(root, {
      message: updated.blockedReason,
      taskId: updated.id,
      taskTitle: updated.title,
      taskSource: updated.source,
      ...(updated.runId !== undefined ? { runId: updated.runId } : {}),
      ...(updated.workflowRun?.currentStepId !== undefined
        ? { workflowStep: updated.workflowRun.currentStepId }
        : {})
    }).catch(() => {});
  }
  return updated;
}

export async function markTaskRunning(
  root: string,
  taskId: string,
  updates: Partial<HarnessTask> = {}
): Promise<HarnessTask> {
  return patchTaskExecution(
    root,
    taskId,
    { pausedAt: null, interruptedAt: null, blockedReason: null },
    { startedAt: updates.startedAt ?? now(), ...updates },
    { clear: ["currentActivity"] }
  );
}

export async function markTaskBlocked(
  root: string,
  taskId: string,
  blockedReason: string,
  updates: Partial<HarnessTask> = {}
): Promise<HarnessTask> {
  return patchTaskExecution(root, taskId, { blockedReason, pausedAt: null, interruptedAt: null }, updates, {
    clear: ["currentActivity"]
  });
}

export async function markTaskPaused(
  root: string,
  taskId: string,
  updates: Partial<HarnessTask> = {}
): Promise<HarnessTask> {
  return patchTaskExecution(
    root,
    taskId,
    {
      pausedAt: now(),
      ...(updates.blockedReason !== undefined ? { blockedReason: updates.blockedReason } : {})
    },
    updates,
    { clear: ["currentActivity"] }
  );
}

export async function markTaskInterrupted(
  root: string,
  taskId: string,
  updates: Partial<HarnessTask> = {}
): Promise<HarnessTask> {
  return patchTaskExecution(root, taskId, { interruptedAt: now() }, updates, {
    clear: ["currentActivity"]
  });
}

export async function markTaskCompleted(
  root: string,
  taskId: string,
  updates: Partial<HarnessTask> = {}
): Promise<HarnessTask> {
  const existing = await getTask(root, taskId);
  // A terminal handoff (author finish or reviewer approval) must not complete a
  // task whose MR/PR has not landed on the forge. That work is still awaiting human
  // review/merge and must resurface as operator work until the merge-status sweep
  // confirms the merge; completing it now would show done work the homepage can only
  // repair on the next hourly sweep. Withhold the completion fields so the task stays
  // unresolved; `finalizeCompletedTaskMemory` gates on resolution and skips it too.
  if (existing && isMergePending(existing)) {
    const { completedAt: _withheld, ...rest } = updates;
    return patchTaskExecution(
      root,
      taskId,
      { pausedAt: null, interruptedAt: null, blockedReason: null },
      rest,
      { clear: ["currentActivity", "completedAt"] }
    );
  }
  const timestamp = now();
  return patchTaskExecution(
    root,
    taskId,
    { resolution: "completed", completedAt: timestamp, pausedAt: null, interruptedAt: null, blockedReason: null },
    updates,
    { clear: ["currentActivity"] }
  );
}

export async function setTaskResolution(
  root: string,
  taskId: string,
  resolution: Resolution
): Promise<HarnessTask> {
  const { listAllRuns, updateRun } = await import("./runs.ts");
  const { abortInflightTurn } = await import("../../runtime/sessions.ts");
  abortInflightTurn(taskId);
  const completedAt = now();
  const runs = await listAllRuns(root);
  for (const run of runs.filter((r) => r.taskId === taskId && r.status === "running")) {
    await updateRun(root, run.id, {
      status: "paused",
      completedAt,
      blockedReason: "Task resolved by operator"
    }).catch(() => {});
  }
  return patchTaskExecution(
    root,
    taskId,
    {
      resolution,
      completedAt: now(),
      pausedAt: null,
      interruptedAt: null,
      blockedReason: null,
      runId: null
    },
    {},
    { clear: ["currentActivity"] }
  );
}

async function assertTaskStageAgentStep(
  root: string,
  task: HarnessTask,
  stage: string
): Promise<void> {
  if (!task.workflowRun) {
    throw new Error("Task has no workflow run.");
  }
  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  assertValidWorkflowStep(workflow, stage);
  const step = workflow.steps[stage]!;
  if (step.agent === "none") {
    throw new Error(`Step "${stage}" does not use an agent.`);
  }
}

export async function setTaskStageAgentOverride(
  root: string,
  taskId: string,
  stage: string,
  agent: ToolId
): Promise<HarnessTask> {
  // Eligibility follows the agent dropdown, which is built from the agent config
  // bundle — any tool it lists must be assignable here. No hardcoded allowlist.
  if (!(await isRegisteredAgent(root, agent))) {
    throw new Error(unregisteredAgentMessage(agent));
  }
  const task = await getTask(root, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  await assertTaskStageAgentStep(root, task, stage);
  return updateTask(root, taskId, (current) => ({
    ...current,
    stageAgentOverrides: { ...current.stageAgentOverrides, [stage]: agent },
    // Changing the agent is a deliberate operator intervention to work around the
    // cause of prior failures (e.g. a provider usage limit). Give the step a fresh
    // resume budget so the attempt cap doesn't permanently block recovery.
    resumeAttempts: 0,
    resumeAttemptsStepId: stage,
    updatedAt: now()
  }));
}

export async function clearTaskStageAgentOverride(
  root: string,
  taskId: string,
  stage: string
): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  await assertTaskStageAgentStep(root, task, stage);
  return updateTask(root, taskId, (current) => {
    if (!current.stageAgentOverrides?.[stage]) {
      return current;
    }
    const nextOverrides = { ...current.stageAgentOverrides };
    delete nextOverrides[stage];
    const base = Object.keys(nextOverrides).length
      ? { ...current, stageAgentOverrides: nextOverrides }
      : omitTaskKeys(current, ["stageAgentOverrides"]);
    return {
      ...base,
      // Reverting to the workflow default is also a deliberate agent change; reset
      // the resume budget so the attempt cap doesn't keep the step blocked.
      resumeAttempts: 0,
      resumeAttemptsStepId: stage,
      updatedAt: now()
    };
  });
}

async function assertTaskStageEffortStep(
  root: string,
  task: HarnessTask,
  stage: string
): Promise<void> {
  if (!task.workflowRun) {
    throw new Error("Task has no workflow run.");
  }
  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  assertValidWorkflowStep(workflow, stage);
  if (!stepSupportsEffort(workflow, stage)) {
    throw new Error(`Step "${stage}" does not support effort.`);
  }
}

export async function setTaskStageEffortOverride(
  root: string,
  taskId: string,
  stage: string,
  effort: EffortLevel
): Promise<HarnessTask> {
  if (!isEffortLevel(effort)) {
    throw new Error(`Invalid effort level: ${String(effort)}`);
  }
  const task = await getTask(root, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  await assertTaskStageEffortStep(root, task, stage);
  return updateTask(root, taskId, (current) => ({
    ...current,
    stageEffortOverrides: { ...current.stageEffortOverrides, [stage]: effort },
    updatedAt: now()
  }));
}

export async function clearTaskStageEffortOverride(
  root: string,
  taskId: string,
  stage: string
): Promise<HarnessTask> {
  const task = await getTask(root, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  await assertTaskStageEffortStep(root, task, stage);
  return updateTask(root, taskId, (current) => {
    if (!current.stageEffortOverrides?.[stage]) {
      return current;
    }
    const nextOverrides = { ...current.stageEffortOverrides };
    delete nextOverrides[stage];
    const base = Object.keys(nextOverrides).length
      ? { ...current, stageEffortOverrides: nextOverrides }
      : omitTaskKeys(current, ["stageEffortOverrides"]);
    return { ...base, updatedAt: now() };
  });
}

export async function setPmStatusOverride(
  root: string,
  taskId: string,
  value: PmStatus
): Promise<HarnessTask> {
  if (value === "done") {
    return setTaskResolution(root, taskId, "completed");
  }
  return updateTask(root, taskId, (task) => ({
    ...task,
    statusOverride: { value, setAt: now() },
    updatedAt: now()
  }));
}

/** @deprecated Use patchTaskExecution / markTask* helpers. */
export async function setTaskStatus(
  root: string,
  taskId: string,
  status: TaskStatus,
  updates: Partial<HarnessTask> = {},
  options?: { clear?: Array<keyof HarnessTask> }
): Promise<HarnessTask> {
  switch (status) {
    case "running":
      return markTaskRunning(root, taskId, updates);
    case "blocked":
      return markTaskBlocked(root, taskId, updates.blockedReason ?? "Blocked", updates);
    case "paused":
      return markTaskPaused(root, taskId, updates);
    case "interrupted":
      return markTaskInterrupted(root, taskId, updates);
    case "completed":
    case "cancelled":
      return setTaskResolution(root, taskId, status === "completed" ? "completed" : "cancelled");
    default:
      return patchTaskExecution(root, taskId, {}, updates, options);
  }
}

export async function cancelTask(root: string, taskId: string): Promise<HarnessTask> {
  return setTaskResolution(root, taskId, "cancelled");
}

export async function pauseTask(
  root: string,
  taskId: string,
  updates: Partial<HarnessTask> = {}
): Promise<HarnessTask> {
  return markTaskPaused(root, taskId, updates);
}

export async function deleteTask(root: string, taskId: string): Promise<HarnessTask> {
  const tasks = await listTasks(root);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index === -1) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const [deleted] = tasks.splice(index, 1);
  await writeJsonFile(tasksPath(root), tasks);
  emitStateChange(["chrome", "tasks"]);
  return deleted!;
}

export async function deleteTasks(root: string, taskIds: string[]): Promise<{ deleted: number }> {
  const ids = new Set(taskIds);
  const tasks = await listTasks(root);
  const remaining = tasks.filter((task) => !ids.has(task.id));
  await writeJsonFile(tasksPath(root), remaining);
  emitStateChange(["chrome", "tasks"]);
  return { deleted: tasks.length - remaining.length };
}

/**
 * Rewrite a path that is exactly the old project root, or nested beneath it, to
 * the new root. Returns the original value when it is unrelated, so unrelated
 * targets and other projects' paths are left untouched.
 */
function repointPath(value: string | undefined, oldPath: string, newPath: string): string | undefined {
  if (!value) return value;
  if (value === oldPath) return newPath;
  if (value.startsWith(oldPath + path.sep)) return newPath + value.slice(oldPath.length);
  return value;
}

/**
 * Cascade a project repoint onto its tasks: rewrite each task's `repoPath` and
 * any `targets[].path` that sits at or under the old root to the new root.
 * Keyed by `projectId` (every task carries one), so it never touches another
 * project's tasks. Idempotent: a second run with the same arguments writes nothing.
 */
export async function repointProjectTasks(
  root: string,
  projectId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  const tasks = await listTasks(root);
  const changedScopes: StateScope[] = [];
  let changed = false;

  const next = tasks.map((task) => {
    if (task.projectId !== projectId) return task;

    const repoPath = repointPath(task.repoPath, oldPath, newPath);
    const repoChanged = repoPath !== task.repoPath;

    let targets = task.targets;
    let targetsChanged = false;
    for (let i = 0; i < task.targets.length; i += 1) {
      const current = task.targets[i]!;
      const rewritten = repointPath(current.path, oldPath, newPath);
      if (rewritten !== current.path) {
        if (!targetsChanged) {
          targets = task.targets.slice();
          targetsChanged = true;
        }
        targets[i] = { ...current, path: rewritten! };
      }
    }

    if (!repoChanged && !targetsChanged) return task;

    changed = true;
    changedScopes.push(...taskScopes(task.id));
    return {
      ...task,
      targets,
      ...(repoChanged ? { repoPath: repoPath! } : {}),
      updatedAt: now()
    };
  });

  if (changed) {
    await writeJsonFile(tasksPath(root), next);
    emitStateChange(changedScopes);
  }
}

export async function updateTask(
  root: string,
  taskId: string,
  updater: (task: HarnessTask) => HarnessTask,
  options?: { scopes?: StateScope[]; silent?: boolean }
): Promise<HarnessTask> {
  const tasks = await listTasks(root);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index === -1) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const updated = updater(tasks[index]!);
  tasks[index] = updated;
  await writeJsonFile(tasksPath(root), tasks);
  if (!options?.silent) {
    emitStateChange(options?.scopes ?? taskScopes(taskId));
  }
  return updated;
}

export async function updateTaskActivity(
  root: string,
  taskId: string,
  activity: { currentActivity?: string; lastProgressAt?: string }
): Promise<void> {
  const tasks = await listTasks(root);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index === -1) return;
  const current = tasks[index]!;
  const nextActivity = activity.currentActivity ?? current.currentActivity;
  const nextProgress = activity.lastProgressAt ?? current.lastProgressAt;
  if (nextActivity === current.currentActivity && nextProgress === current.lastProgressAt) {
    return;
  }
  tasks[index] = {
    ...current,
    ...(nextActivity !== undefined ? { currentActivity: nextActivity } : {}),
    ...(nextProgress !== undefined ? { lastProgressAt: nextProgress } : {}),
    updatedAt: now()
  };
  await writeJsonFile(tasksPath(root), tasks);
  emitStateChange([taskActivityScope(taskId)]);
}
