import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../core/infra/fs.ts";
import { runHooks } from "../core/review/hooks.ts";
import { claimRunForTask, updateRun } from "../core/tasks/runs.ts";
import { resolveRunIdentityFromRouting } from "../core/agents/config/run-identity.ts";
import { loadAgentConfig } from "../core/agents/config/store.ts";
import { loadUsageSnapshots } from "../core/agents/config/usage-store.ts";
import {
  buildRoutingDecisionRecord,
  type RoutingDecisionRecord
} from "../core/runs/routing-decision.ts";
import {
  quotaStateForPool,
  resolveStepRoutingContext,
  type StepRoutingContext
} from "../core/runs/routing-inspect.ts";
import { EntityNotFoundError } from "../core/tasks/errors.ts";
import { HEARTBEAT_INTERVAL_MS } from "../core/tasks/activity.ts";
import {
  prepareStepWorkspace
} from "../core/worktrees/worktrees.ts";
import {
  advanceTaskWorkflowStep,
  getTask,
  markTaskBlocked,
  markTaskCompleted,
  patchTaskExecution,
  updateTask,
  updateTaskActivity
} from "../core/tasks/tasks.ts";
import { deriveExecution } from "../core/tasks/status.ts";
import { resolveStepExtensions } from "../core/agents/extensions/launch.ts";
import {
  formatStepNoRouteMessage,
  resolveAgentForStep,
  resolveStepRouting,
  type ResolvedRouting
} from "../core/agents/stage-agents.ts";
import { getCurrentStep } from "../core/workflows/run.ts";
import {
  getStep,
  loadWorkflow
} from "../core/workflows/index.ts";
import type { HarnessTask } from "../core/types.ts";
import { createRunnerForRouting } from "../runners/index.ts";
import type { AgentActivity } from "../runners/types.ts";
import { clearInflightTurn, registerInflightTurn } from "../runtime/sessions.ts";
import { captureLessonFromReply } from "../memory/auto-capture.ts";
import { runTaskTurn } from "./processor.ts";
import { finalizeCompletedTaskMemory, completeAgentTurn } from "./turn-completion.ts";
import {
  now,
  type AdvanceAuthorTurnContext,
  type ProcessOptions,
  type RunTurnInternal,
  type TurnSummary
} from "./types.ts";
import { roleCapability } from "../core/agents/stage-routing.ts";

async function refreshRunningTask(
  root: string,
  taskId: string,
  updates: Partial<HarnessTask>
): Promise<void> {
  await updateTask(root, taskId, (current) => ({
    ...current,
    ...updates,
    updatedAt: now()
  }));
}

export class AgentCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCapacityError";
  }
}

export async function requireStepAgent(root: string, task: HarnessTask, stepId: string): Promise<ResolvedRouting> {
  if (!task.workflowRun) {
    throw new Error(`Task ${task.id} has no workflow run.`);
  }
  const routing = await resolveStepRouting(
    root,
    task.workflowRun.workflowId,
    stepId,
    task.stageAgentOverrides,
    task.stageModelPoolOverrides,
    undefined,
    task.agentSessionId && task.agentSessionAgent && task.agentSessionModelPool
      ? { agent: task.agentSessionAgent, modelPoolId: task.agentSessionModelPool }
      : undefined
  );
  if (!routing) {
    const preferred = await resolveAgentForStep(
      root,
      task.workflowRun.workflowId,
      stepId,
      task.stageAgentOverrides
    );
    if (!preferred) {
      throw new Error(`No agent configured for workflow step "${stepId}".`);
    }
    throw new AgentCapacityError(
      await formatStepNoRouteMessage(
        root,
        task.workflowRun.workflowId,
        stepId,
        task.stageAgentOverrides,
        task.stageModelPoolOverrides
      )
    );
  }
  return routing;
}

export async function resolveTurnAgent(
  root: string,
  task: HarnessTask,
  stepId: string
): Promise<ResolvedRouting | TurnSummary> {
  try {
    return await requireStepAgent(root, task, stepId);
  } catch (error) {
    if (error instanceof AgentCapacityError) {
      await markTaskBlocked(root, task.id, error.message);
      return { runId: task.runId ?? task.id, execution: "blocked" };
    }
    throw error;
  }
}

async function routingDecisionForTurn(
  root: string,
  internal: RunTurnInternal
): Promise<RoutingDecisionRecord | undefined> {
  const task = internal.task;
  if (!task.workflowRun) return undefined;

  const identity = await resolveRunIdentityFromRouting(root, internal.agent, internal.modelPoolId);
  if (!identity) return undefined;

  const [bundle, usage] = await Promise.all([loadAgentConfig(root), loadUsageSnapshots(root)]);

  if (internal.routingContext) {
    const capability =
      internal.routingContext.explanation?.capability ?? roleCapability(internal.step.agent);
    return buildRoutingDecisionRecord({
      harness: internal.agent,
      modelPoolId: internal.modelPoolId,
      capability,
      source: internal.routingContext.routing.source,
      reason: internal.routingContext.routing.routeReason ?? internal.routingContext.routing.source,
      identity,
      quotaState: quotaStateForPool(bundle, usage, internal.agent, internal.modelPoolId),
      explanation: internal.routingContext.explanation
    });
  }

  const context: StepRoutingContext | null = await resolveStepRoutingContext(
    root,
    task.workflowRun.workflowId,
    internal.step.id,
    task.stageAgentOverrides,
    task.stageModelPoolOverrides,
    internal.workspace.cwd
  );
  if (!context) return undefined;

  const capability =
    context.explanation?.capability ?? roleCapability(internal.step.agent);

  return buildRoutingDecisionRecord({
    harness: internal.agent,
    modelPoolId: internal.modelPoolId,
    capability,
    source: context.routing.source,
    reason: context.routing.routeReason ?? context.routing.source,
    identity,
    quotaState: quotaStateForPool(bundle, usage, internal.agent, internal.modelPoolId),
    explanation: context.explanation
  });
}

export async function executeAgentTurn(root: string, internal: RunTurnInternal): Promise<TurnSummary | null> {
  const { task, prompt, workspace, resolvedRunner, options } = internal;
  const startedAt = now();
  const workflow = await loadWorkflow(root, task.workflowRun!.workflowId);

  const resolvedIdentity = await resolveRunIdentityFromRouting(root, internal.agent, internal.modelPoolId);
  const routingDecision = await routingDecisionForTurn(root, internal);

  const run = await claimRunForTask(root, {
    taskId: task.id,
    taskTitle: task.title,
    ...(task.projectId !== undefined ? { projectId: task.projectId } : {}),
    agent: internal.agent,
    status: "running",
    startedAt,
    artifacts: ["prompt.md", "log.txt"],
    modelPoolId: internal.modelPoolId,
    stepId: internal.step.id,
    ...(resolvedIdentity ? { resolvedIdentity } : {}),
    ...(routingDecision ? { routingDecision } : {})
  });
  if (!run) return null;

  await refreshRunningTask(root, task.id, {
    startedAt: task.startedAt ?? startedAt,
    runId: run.id,
    agent: internal.agent,
    lastProgressAt: startedAt,
    currentActivity: "starting up"
  });

  const runDir = path.join(root, "data", "runs", run.id);
  await ensureDir(runDir);
  const logPath = path.join(runDir, "log.txt");
  await writeFile(path.join(runDir, "prompt.md"), prompt, "utf8");
  await writeFile(logPath, "", "utf8");

  const extensionLaunch = await resolveStepExtensions({
    root,
    toolId: internal.agent,
    step: internal.step,
    cwd: workspace.cwd
  });
  const launchInternal: RunTurnInternal = {
    ...internal,
    enabledExtensionIds: extensionLaunch.enabledIds,
    extensionEntries: extensionLaunch.entries
  };

  const hookBlockStart = await runHooks(workspace.cwd, "on_turn_start", {
    task: { id: task.id, title: task.title, description: task.description, agent: internal.agent },
    runId: run.id,
    prompt,
    workspace: { cwd: workspace.cwd, isRepo: workspace.isRepo }
  });
  if (hookBlockStart) {
    await updateRun(root, run.id, { status: "blocked", completedAt: now(), blockedReason: hookBlockStart.reason });
    const blocked = await markTaskBlocked(root, task.id, hookBlockStart.reason, {
      completedAt: now(),
      runId: run.id
    });
    return { runId: run.id, execution: deriveExecution(blocked) };
  }

  registerInflightTurn(task.id, resolvedRunner, run.id);

  let sessionPersisted = false;
  const onSessionId = (sessionId: string): void => {
    if (sessionPersisted) return;
    sessionPersisted = true;
    void updateTask(root, task.id, (current) => ({
      ...current,
      agentSessionId: sessionId,
      updatedAt: now()
    })).catch(() => {});
  };

  let latestActivity: AgentActivity = { label: "starting up", at: startedAt };
  let flushedAt = startedAt;
  const flushActivity = (): void => {
    if (latestActivity.at === flushedAt) return;
    flushedAt = latestActivity.at;
    void updateTaskActivity(root, task.id, {
      lastProgressAt: latestActivity.at,
      currentActivity: latestActivity.label
    }).catch(() => {});
  };
  const onActivity = (activity: AgentActivity): void => {
    latestActivity = activity;
  };
  const heartbeat = setInterval(flushActivity, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const completion = completeAgentTurn({
    root,
    internal: launchInternal,
    workflow,
    run,
    runDir,
    logPath,
    resolvedRunner,
    heartbeat,
    onActivity,
    onSessionId
  });

  if (options?.wait) {
    return completion;
  }

  completion.catch(async (err) => {
    clearInflightTurn(task.id, run.id);
    clearInterval(heartbeat);
    const reason = err instanceof Error ? err.message : String(err);
    await updateRun(root, run.id, {
      status: "blocked",
      completedAt: now(),
      blockedReason: reason
    }).catch((updateErr) => {
      if (updateErr instanceof EntityNotFoundError) return;
      throw updateErr;
    });
    await markTaskBlocked(root, task.id, reason, {
      completedAt: now(),
      runId: run.id
    }).catch((updateErr) => {
      if (updateErr instanceof EntityNotFoundError) return;
      throw updateErr;
    });
  });
  return { runId: run.id, execution: "running" };
}

export async function scheduleAuthorRerun(
  root: string,
  taskId: string,
  prompt: string,
  options?: ProcessOptions,
  stepId?: string,
  meta?: { checksRemediation?: { round: number } }
): Promise<TurnSummary> {
  const task = (await getTask(root, taskId))!;
  const workflow = await loadWorkflow(root, task.workflowRun!.workflowId);
  const step = getStep(workflow, stepId ?? task.workflowRun!.currentStepId);
  const workspace = await prepareStepWorkspace(task, step, { harnessRoot: root });
  const agentResult = await resolveTurnAgent(root, task, step.id);
  if ("execution" in agentResult) return agentResult;
  const routing = agentResult;
  const resolvedRunner =
    options?.runner ??
    (await createRunnerForRouting(root, routing, {
      stepContext: {
        stepKind: step.kind,
        reviewer: false,
        checksRemediation: Boolean(meta?.checksRemediation)
      }
    }));
  const turn = await executeAgentTurn(root, {
    task,
    prompt,
    agent: routing.toolId,
    modelPoolId: routing.modelPoolId,
    supportsEffort: routing.supportsEffort,
    workspace,
    resolvedRunner,
    ...(options !== undefined ? { options } : {}),
    turnNumber: (task.turnCount ?? 0) + 1,
    isFirstTurn: false,
    step,
    ...(meta?.checksRemediation !== undefined ? { checksRemediation: meta.checksRemediation } : {})
  });
  return turn ?? { runId: task.runId ?? task.id, execution: "running" };
}

export async function advanceAuthorTurnWorkflow(
  root: string,
  context: AdvanceAuthorTurnContext
): Promise<TurnSummary> {
  const {
    task,
    workflow,
    run,
    replyBody,
    options,
    baseUpdates,
    runId,
    completedAt,
    statusClear = []
  } = context;

  const advanced = await advanceTaskWorkflowStep(root, task.id);
  const nextStep = getCurrentStep(workflow, advanced.workflowRun!);

  if (nextStep.kind === "create_merge_request") {
    if (options?.replayExternalSteps) {
      await updateTask(root, task.id, (current) => ({
        ...current,
        mergeRequest: { provider: "github", url: "https://replay.invalid/merge-request/1", number: 1, state: "open" },
        updatedAt: now()
      }));
      await advanceTaskWorkflowStep(root, task.id);
      const afterMergeRequest = await getTask(root, task.id);
      if (afterMergeRequest?.workflowRun && getCurrentStep(workflow, afterMergeRequest.workflowRun).kind === "resolve_conflicts") {
        await advanceTaskWorkflowStep(root, task.id);
      }
      const updated = await patchTaskExecution(root, task.id, { blockedReason: null }, baseUpdates);
      return { runId, execution: deriveExecution(updated) };
    }
    await patchTaskExecution(root, task.id, { blockedReason: null }, baseUpdates);
    const chained = await runTaskTurn(root, task.id, { ...options, wait: options?.wait ?? true });
    void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
    if (chained) {
      const refreshed = (await getTask(root, task.id))!;
      const chainedStep = refreshed.workflowRun
        ? getStep(workflow, refreshed.workflowRun.currentStepId)
        : null;
      const hasMergeRequestForReview = Boolean(refreshed.mergeRequest);
      if (
        chainedStep?.kind === "review" &&
        hasMergeRequestForReview
      ) {
        await patchTaskExecution(root, task.id, { blockedReason: null }, baseUpdates);
        return scheduleReviewerTurn(root, task.id, options);
      }
      return chained;
    }

    const refreshed = (await getTask(root, task.id))!;
    return { runId, execution: deriveExecution(refreshed) };
  }

  if (nextStep.kind === "review") {
    const refreshed = (await getTask(root, task.id))!;
    const hasMergeRequestForReview = Boolean(refreshed.mergeRequest);
    if (!hasMergeRequestForReview) {
      void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
      const updated = await patchTaskExecution(root, task.id, { blockedReason: null }, baseUpdates);
      return { runId, execution: deriveExecution(updated) };
    }
    await patchTaskExecution(root, task.id, { blockedReason: null }, baseUpdates);
    void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
    return scheduleReviewerTurn(root, task.id, options);
  }

  const updated =
    nextStep.kind === "terminal"
      ? await markTaskCompleted(root, task.id, { ...baseUpdates, completedAt })
      : await patchTaskExecution(
          root,
          task.id,
          { blockedReason: null },
          baseUpdates,
          { clear: ["completedAt", ...statusClear.filter((key) => key !== "completedAt")] }
        );
  void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
  if (nextStep.kind === "terminal") {
    void finalizeCompletedTaskMemory(root, task.id, replyBody);
  }
  return { runId, execution: deriveExecution(updated) };
}

export async function scheduleReviewerTurn(
  root: string,
  taskId: string,
  options: ProcessOptions | undefined
): Promise<TurnSummary> {
  const task = (await getTask(root, taskId))!;
  const workflow = await loadWorkflow(root, task.workflowRun!.workflowId);
  const step = getCurrentStep(workflow, task.workflowRun!);
  if (step.kind !== "review" && step.next) {
    await advanceTaskWorkflowStep(root, taskId);
  }
  const turn = await runTaskTurn(root, taskId, {
    ...(options ?? {}),
    ...(options?.wait !== undefined ? { wait: options.wait } : {})
  });
  const refreshed = await getTask(root, taskId);
  return (
    turn ?? {
      runId: task.runId ?? task.id,
      execution: deriveExecution(refreshed ?? task)
    }
  );
}
