import { buildFollowupCapturePrompt } from "../core/review/followup-capture.ts";
import { describeCheckPlan } from "../core/review/checks.ts";
import { planProjectChecks } from "../core/projects/project-checks.ts";
import {
  formatWorkspaceArtifactsSection,
  gatherWorkspaceArtifacts
} from "../core/worktrees/workspace-artifacts.ts";
import { shouldAttachWorkspaceArtifacts } from "../core/workflows/mechanics.ts";
import { loadSkillsIndex } from "../core/catalog/kernel.ts";
import {
  buildReviewerPrompt,
  gatherReviewContext
} from "../core/review/code-review.ts";
import {
  inspectPostTurnGit,
  prepareStepWorkspace
} from "../core/worktrees/worktrees.ts";
import {
  advanceTaskWorkflowStep,
  getTask,
  listTasks,
  markTaskBlocked,
  markTaskRunning,
  patchTaskExecution,
  rehydrateTaskTargets,
  routeTaskToImplementationStep,
  routeTaskToMergeRequestStep,
  updateTask
} from "../core/tasks/tasks.ts";
import { listAllRuns } from "../core/tasks/runs.ts";
import {
  isDaemonQueueCandidate,
  isTaskResumable,
  isTaskRunnable,
  isTaskRunning,
  isTaskTerminal
} from "../core/tasks/status.ts";
import {
  currentStepNeedsApproval,
  getCurrentStep
} from "../core/workflows/run.ts";
import {
  buildConversationFollowupPrompt,
  buildConversationPrompt,
  buildFollowupPrompt,
  hasOperatorReplySinceLastAgentTurn
} from "../core/workflows/prompts.ts";
import {
  findImplementationStepId,
  findRepoRemediationStepId,
  isPostPushWorkflowStep,
  loadWorkflow,
  stepModifiesRepo,
  taskNeedsGitOperatorFollowup
} from "../core/workflows/index.ts";
import type { HarnessTask } from "../core/types.ts";
import { listInflightTaskIds } from "../runtime/sessions.ts";
import { createRunnerForTool } from "../runners/index.ts";
import type { ResolvedRouting } from "../core/agents/stage-agents.ts";
import { buildMemoryRecallSection } from "../memory/recall.ts";
import { executeAgentTurn, resolveTurnAgent, scheduleReviewerTurn } from "./agent-turn.ts";
import { buildInitialPrompt, buildKernelHeader } from "./prompts.ts";
import { executeCreateMergeRequestStep } from "./step-handlers/merge-request.ts";
import { executeResolveConflictsStep } from "./step-handlers/resolve-conflicts.ts";
import {
  MAX_RESUME_ATTEMPTS,
  now,
  type ProcessOptions,
  type TurnSummary
} from "./types.ts";

export type { ProcessOptions, TurnSummary } from "./types.ts";
export { looksLikeFinalAnswer } from "./final-answer.ts";

export function shouldAutoRunAuthorForOperatorFollowup(
  task: HarnessTask,
  workflow: Awaited<ReturnType<typeof loadWorkflow>>
): boolean {
  return taskNeedsGitOperatorFollowup(task, workflow);
}

function reviewRequiresMergeRequest(task: HarnessTask): boolean {
  return Boolean(
    task.repoPath &&
      task.branch &&
      task.pushedAt &&
      task.workflowRun?.completedSteps.includes("create_merge_request") &&
      !task.mergeRequest
  );
}

async function listPersistedRunningTaskIds(root: string): Promise<Set<string>> {
  const runs = await listAllRuns(root);
  return new Set(runs.filter((run) => run.status === "running").map((run) => run.taskId));
}

async function hasPersistedRunningRun(root: string, taskId: string): Promise<boolean> {
  return (await listPersistedRunningTaskIds(root)).has(taskId);
}

export async function runOperatorFollowupTurn(
  root: string,
  taskId: string,
  options?: ProcessOptions
): Promise<TurnSummary | null> {
  const task = await getTask(root, taskId);
  if (!task?.workflowRun) return null;

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  if (!shouldAutoRunAuthorForOperatorFollowup(task, workflow)) return null;
  if (isTaskRunning(task, listInflightTaskIds())) return null;

  const remediationStepId = findRepoRemediationStepId(workflow);
  if (!remediationStepId) return null;

  const step = getCurrentStep(workflow, task.workflowRun);
  if (isPostPushWorkflowStep(workflow, step.id)) {
    await routeTaskToImplementationStep(root, taskId);
  }

  return runTaskTurn(root, taskId, options);
}

export async function runTaskTurn(
  root: string,
  taskId: string,
  options?: ProcessOptions
): Promise<TurnSummary | null> {
  const task = await getTask(root, taskId);
  if (!task || !task.workflowRun) return null;
  if (isTaskRunning(task, listInflightTaskIds())) return null;
  if (await hasPersistedRunningRun(root, task.id)) return null;

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  const step = getCurrentStep(workflow, task.workflowRun);
  if (step.kind === "terminal") return null;
  if (currentStepNeedsApproval(workflow, task.workflowRun)) return null;
  if (!isTaskRunnable(task, workflow)) return null;

  if (step.kind === "agent_turn" && step.agent === "none") {
    const advanced = await advanceTaskWorkflowStep(root, task.id);
    const nextStep = getCurrentStep(workflow, advanced.workflowRun!);
    if (nextStep.kind === "terminal" || advanced.resolution === "completed") {
      return { runId: task.runId ?? task.id, execution: "idle" };
    }
    return runTaskTurn(root, task.id, options);
  }

  const implementationStepId = findImplementationStepId(workflow);
  if (
    implementationStepId &&
    task.workflowRun.currentStepId === implementationStepId &&
    task.pushedAt &&
    step.kind === "agent_turn" &&
    step.skill === "pr-driven-execution"
  ) {
    const recoveryWorkspace = await prepareStepWorkspace(task, step, { harnessRoot: root });
    const gitState = await inspectPostTurnGit(recoveryWorkspace);
    if (gitState?.pushed) {
      await advanceTaskWorkflowStep(root, task.id);
      return runTaskTurn(root, task.id, options);
    }
  }

  const isFirstTurn = (task.turnCount ?? 0) === 0;
  const turnNumber = (task.turnCount ?? 0) + 1;
  const taskWithTargets = await rehydrateTaskTargets(root, task);
  const workspace = await prepareStepWorkspace(taskWithTargets, step, { harnessRoot: root });
  await updateTask(root, taskWithTargets.id, (current) => {
    const nextRepoPath = workspace.repoPath ?? current.repoPath;
    const nextBranch = workspace.branch ?? current.branch;
    return {
      ...current,
      workspacePath: workspace.cwd,
      ...(nextRepoPath !== undefined ? { repoPath: nextRepoPath } : {}),
      ...(nextBranch !== undefined ? { branch: nextBranch } : {}),
      updatedAt: now()
    };
  });

  const refreshed = (await getTask(root, taskWithTargets.id))!;
  const skills = await loadSkillsIndex(root);
  const kernelHeader = buildKernelHeader(root, refreshed, skills);
  const operatorFollowup = hasOperatorReplySinceLastAgentTurn(refreshed)
    ? (refreshed.messages ?? []).filter((m) => m.author === "operator").at(-1)?.body
    : undefined;
  const memorySection = await buildMemoryRecallSection(root, refreshed, {
    ...(operatorFollowup !== undefined ? { extraQuery: operatorFollowup } : {})
  });

  let prompt: string;
  let routing: ResolvedRouting | undefined;
  let conversation = false;

  if (step.kind === "conversation") {
    conversation = true;
    const agentResult = await resolveTurnAgent(root, refreshed, step.id);
    if ("execution" in agentResult) return agentResult;
    routing = agentResult;
    prompt = operatorFollowup
      ? buildConversationFollowupPrompt(refreshed, step, workspace.cwd, root, kernelHeader, memorySection)
      : buildConversationPrompt(refreshed, step, workspace.cwd, root, kernelHeader, memorySection);
  } else if (step.kind === "review") {
    if (reviewRequiresMergeRequest(refreshed)) {
      // The create_merge_request step is marked complete but no merge request was
      // ever persisted (e.g. it was advanced via an operator rollback/skip rather
      // than executed). Resuming review can never satisfy this precondition, so
      // reopen create_merge_request and re-run it. Its handler reuses an existing
      // open PR/MR or creates one, persists the metadata, and advances to review.
      await routeTaskToMergeRequestStep(root, refreshed.id);
      return runTaskTurn(root, taskId, options);
    }

    const authorStepId = findImplementationStepId(workflow) ?? step.id;
    const reviewerResult = await resolveTurnAgent(root, refreshed, step.id);
    if ("execution" in reviewerResult) return reviewerResult;
    const reviewerRouting = reviewerResult;
    const authorResult = await resolveTurnAgent(root, refreshed, authorStepId);
    if ("execution" in authorResult) return authorResult;
    const authorAgent = authorResult.toolId;
    const gitState = await inspectPostTurnGit(workspace);
    const authorReply = (refreshed.messages ?? []).filter((m) => m.author === "agent").at(-1)?.body ?? "";
    const reviewContext = await gatherReviewContext({
      task: refreshed,
      workspace,
      gitState,
      authorReply
    });
    prompt = buildReviewerPrompt({
      task: refreshed,
      authorAgent,
      context: reviewContext,
      memorySection
    });
    await markTaskRunning(root, refreshed.id, { startedAt: refreshed.startedAt ?? now() });
    const reviewerRunner =
      options?.reviewerRunner ??
      options?.runner ??
      (await createRunnerForTool(root, reviewerRouting.toolId, "reviewer"));
    return executeAgentTurn(root, {
      task: (await getTask(root, refreshed.id))!,
      prompt,
      agent: reviewerRouting.toolId,
      modelPoolId: reviewerRouting.modelPoolId,
      supportsEffort: reviewerRouting.supportsEffort,
      workspace,
      resolvedRunner: reviewerRunner,
      ...(options !== undefined ? { options } : {}),
      turnNumber: refreshed.turnCount ?? 0,
      isFirstTurn: false,
      step,
      reviewer: { round: (refreshed.reviewRounds ?? 0) + 1 }
    });
  } else if (step.kind === "create_merge_request") {
    const mrSummary = await executeCreateMergeRequestStep(root, refreshed, workspace, step, options);
    const afterMr = (await getTask(root, taskId))!;
    if (afterMr.workflowRun) {
      const afterStep = getCurrentStep(workflow, afterMr.workflowRun);
      const hasMergeRequestForReview = Boolean(afterMr.mergeRequest);
      if (afterStep.kind === "resolve_conflicts") {
        return runTaskTurn(root, taskId, options);
      }
      if (
        afterStep.kind === "review" &&
        hasMergeRequestForReview
      ) {
        await patchTaskExecution(root, taskId, { blockedReason: null });
        return scheduleReviewerTurn(root, taskId, options);
      }
    }
    return mrSummary;
  } else if (step.kind === "resolve_conflicts") {
    const resolveSummary = await executeResolveConflictsStep(root, refreshed, workspace, workflow, step, options);
    const afterResolve = (await getTask(root, taskId))!;
    if (afterResolve.workflowRun) {
      const afterStep = getCurrentStep(workflow, afterResolve.workflowRun);
      if (afterStep.kind === "review" && Boolean(afterResolve.mergeRequest)) {
        await patchTaskExecution(root, taskId, { blockedReason: null });
        return scheduleReviewerTurn(root, taskId, options);
      }
    }
    return resolveSummary;
  } else {
    const agentResult = await resolveTurnAgent(root, refreshed, step.id);
    if ("execution" in agentResult) return agentResult;
    routing = agentResult;
    if (step.skill === "tech-debt-capture") {
      prompt = buildFollowupCapturePrompt(refreshed, memorySection);
    } else {
      const useInitialPrompt =
        isFirstTurn || (step.kind === "agent_turn" && !hasOperatorReplySinceLastAgentTurn(refreshed));
      prompt = useInitialPrompt
        ? buildInitialPrompt(
            root,
            refreshed,
            skills,
            workspace,
            memorySection,
            describeCheckPlan(await planProjectChecks(root, refreshed.projectId, workspace.cwd))
          )
        : buildFollowupPrompt(refreshed, root, memorySection);
    }
    if (shouldAttachWorkspaceArtifacts(step.skill)) {
      const artifacts = await gatherWorkspaceArtifacts(workspace);
      prompt += `\n\n${formatWorkspaceArtifactsSection(artifacts)}`;
    }
  }

  await markTaskRunning(root, refreshed.id, { startedAt: refreshed.startedAt ?? now() });
  const resolvedRunner =
    options?.runner ?? (await createRunnerForTool(root, routing!.toolId, "author"));
  return executeAgentTurn(root, {
    task: (await getTask(root, refreshed.id))!,
    prompt,
    agent: routing!.toolId,
    modelPoolId: routing!.modelPoolId,
    supportsEffort: routing!.supportsEffort,
    workspace,
    resolvedRunner,
    ...(options !== undefined ? { options } : {}),
    turnNumber,
    isFirstTurn,
    step,
    ...(conversation ? { conversation } : {})
  });
}

export async function processNextApprovedTask(
  root: string,
  options?: ProcessOptions
): Promise<TurnSummary | null> {
  const [tasks, runningTaskIds] = await Promise.all([listTasks(root), listPersistedRunningTaskIds(root)]);
  const workflows = await Promise.all(
    tasks.map((t) => (t.workflowRun ? loadWorkflow(root, t.workflowRun.workflowId) : null))
  );
  const next = tasks.find((task, i) => {
    const workflow = workflows[i];
    return workflow && !runningTaskIds.has(task.id) && isDaemonQueueCandidate(task, workflow);
  });
  if (!next) return null;
  return runTaskTurn(root, next.id, options);
}

export async function processAllApprovedTasks(
  root: string,
  options?: ProcessOptions
): Promise<TurnSummary[]> {
  const [tasks, runningTaskIds] = await Promise.all([listTasks(root), listPersistedRunningTaskIds(root)]);
  const workflows = await Promise.all(
    tasks.map((t) => (t.workflowRun ? loadWorkflow(root, t.workflowRun.workflowId) : null))
  );
  const candidates = tasks.filter((task, i) => {
    const workflow = workflows[i];
    return workflow && !runningTaskIds.has(task.id) && isDaemonQueueCandidate(task, workflow);
  });
  const results: TurnSummary[] = [];
  for (const task of candidates) {
    const result = await runTaskTurn(root, task.id, options);
    if (result) results.push(result);
  }
  return results;
}

export async function resumeTask(
  root: string,
  taskId: string,
  options?: ProcessOptions
): Promise<TurnSummary | null> {
  const task = await getTask(root, taskId);
  if (!task) return null;
  if (!isTaskResumable(task)) return null;
  if (isTaskRunning(task, listInflightTaskIds())) return null;
  let workflow: Awaited<ReturnType<typeof loadWorkflow>> | undefined;
  if (task.workflowRun) {
    workflow = await loadWorkflow(root, task.workflowRun.workflowId);
    if (isTaskTerminal(task, workflow)) return null;
  }

  // The resume cap is per-step: a task that legitimately advances through many steps
  // must not exhaust a single lifetime budget. Only count attempts accrued on the
  // step the task is currently sitting on; a step change starts a fresh budget.
  const currentStepId = task.workflowRun?.currentStepId;
  const hasCurrentStepAgentOverride =
    currentStepId !== undefined && task.stageAgentOverrides?.[currentStepId] !== undefined;
  const unscopedLegacyAttempts =
    task.resumeAttemptsStepId == null && (task.resumeAttempts ?? 0) > 0 && !hasCurrentStepAgentOverride;
  const sameStep =
    currentStepId !== undefined &&
    (task.resumeAttemptsStepId === currentStepId || unscopedLegacyAttempts);
  const attempts =
    currentStepId === undefined
      ? (task.resumeAttempts ?? 0) + 1
      : (sameStep ? (task.resumeAttempts ?? 0) : 0) + 1;
  if (attempts > MAX_RESUME_ATTEMPTS) {
    await markTaskBlocked(
      root,
      taskId,
      `Exceeded maximum resume attempts (${MAX_RESUME_ATTEMPTS})`
    );
    return null;
  }
  const attemptUpdates =
    currentStepId !== undefined
      ? { resumeAttempts: attempts, resumeAttemptsStepId: currentStepId }
      : { resumeAttempts: attempts };

  if (workflow && task.workflowRun) {
    const step = getCurrentStep(workflow, task.workflowRun);
    if (step.kind === "agent_turn" && stepModifiesRepo(step)) {
      const workspace = await prepareStepWorkspace(task, step, { harnessRoot: root });
      const gitState = await inspectPostTurnGit(workspace);
      if (gitState && gitState.commitCount > 0 && !gitState.hasUnpushedCommits) {
        await patchTaskExecution(
          root,
          taskId,
          { pausedAt: null, interruptedAt: null, blockedReason: null, completedAt: null },
          {
            ...attemptUpdates,
            pushedAt: now(),
            commitCount: gitState.commitCount,
            checkRound: 0
          },
          { clear: ["currentActivity", "lastCheckFailure", "lastRemediationFingerprint"] }
        );
        await advanceTaskWorkflowStep(root, taskId);
        const updated = (await getTask(root, taskId))!;
        return { runId: updated.runId ?? taskId, execution: "idle" };
      }
    }
  }

  await patchTaskExecution(
    root,
    taskId,
    { pausedAt: null, interruptedAt: null, blockedReason: null, completedAt: null },
    attemptUpdates
  );

  return runTaskTurn(root, taskId, options);
}
