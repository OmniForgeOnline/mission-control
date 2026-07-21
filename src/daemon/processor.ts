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
import { gatherReviewSupportingEvidence } from "../core/review/supporting-evidence.ts";
import { reviewerIndependenceViolation } from "../core/review/independence.ts";
import { resolveReviewerIndependence, resolveReviewProfile } from "../core/review/profiles.ts";
import { loadStageModelPoolOverrides } from "../core/agents/stage-model-pools.ts";
import {
  inspectPostTurnGit,
  prepareStepWorkspace
} from "../core/worktrees/worktrees.ts";
import {
  advanceTaskWorkflowStep,
  getTask,
  markTaskBlocked,
  markTaskRunning,
  patchTaskExecution,
  rehydrateTaskTargets,
  routeTaskToMergeRequestStep,
  updateTask
} from "../core/tasks/tasks.ts";
import { listAllRuns } from "../core/tasks/runs.ts";
import {
  isTaskRunnable,
  isTaskRunning
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
import { stepSkillReferenceError } from "../core/workflows/skill-validation.ts";
import {
  findArtifactProducingStepId,
  findImplementationStepId,
  loadWorkflow
} from "../core/workflows/index.ts";
import type { HarnessTask } from "../core/types.ts";
import { listInflightTaskIds } from "../runtime/sessions.ts";
import { createRunnerForRouting } from "../runners/index.ts";
import type { ResolvedRouting } from "../core/agents/stage-agents.ts";
import { resolveStepRoutingContext } from "../core/runs/routing-inspect.ts";
import { buildMemoryRecallSection } from "../memory/recall.ts";
import { executeAgentTurn, resolveTurnAgent, scheduleReviewerTurn } from "./agent-turn.ts";
import { loadRequiredSkillSection } from "../core/workflows/required-skill.ts";
import { buildInitialPrompt, buildStableAgentPrefix } from "./prompts.ts";
import { executeCreateMergeRequestStep } from "./step-handlers/merge-request.ts";
import { executeResolveConflictsStep } from "./step-handlers/resolve-conflicts.ts";
import { now, type ProcessOptions, type TurnSummary } from "./types.ts";

export type { ProcessOptions, TurnSummary } from "./types.ts";
export {
  processAllApprovedTasks,
  processNextApprovedTask,
  resumeTask,
  runOperatorFollowupTurn,
  shouldAutoRunAuthorForOperatorFollowup
} from "./processor-queue.ts";

async function executionRoutingContext(
  root: string,
  task: HarnessTask,
  stepId: string,
  cwd: string
) {
  if (!task.workflowRun) return undefined;
  return (
    (await resolveStepRoutingContext(
      root,
      task.workflowRun.workflowId,
      stepId,
      task.stageAgentOverrides,
      task.stageModelPoolOverrides,
      cwd,
      task.agentSessionId && task.agentSessionAgent && task.agentSessionModelPool
        ? { agent: task.agentSessionAgent, modelPoolId: task.agentSessionModelPool }
        : undefined
    )) ?? undefined
  );
}
export { looksLikeFinalAnswer } from "./final-answer.ts";

function reviewRequiresMergeRequest(task: HarnessTask): boolean {
  return Boolean(
    task.repoPath &&
      task.branch &&
      task.pushedAt &&
      task.workflowRun?.completedSteps.includes("create_merge_request") &&
      !task.mergeRequest
  );
}

async function persistedAuthorRouting(
  root: string,
  taskId: string,
  stepId: string,
  fallback: ResolvedRouting
): Promise<ResolvedRouting> {
  const runs = (await listAllRuns(root))
    .filter((run) => run.taskId === taskId && run.stepId === stepId && run.modelPoolId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const run = runs[0];
  if (!run?.modelPoolId) return fallback;
  return {
    ...fallback,
    toolId: run.agent,
    modelPoolId: run.modelPoolId
  };
}

async function hasPersistedRunningRun(root: string, taskId: string): Promise<boolean> {
  const runs = await listAllRuns(root);
  return runs.some((run) => run.taskId === taskId && run.status === "running");
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
  const workflowId = task.workflowRun.workflowId;
  const operatorFollowup = hasOperatorReplySinceLastAgentTurn(refreshed)
    ? (refreshed.messages ?? []).filter((m) => m.author === "operator").at(-1)?.body
    : undefined;
  const memorySection = await buildMemoryRecallSection(root, refreshed, {
    ...(operatorFollowup !== undefined ? { extraQuery: operatorFollowup } : {})
  });

  const skillReferenceError = await stepSkillReferenceError(root, step);
  if (skillReferenceError) {
    await markTaskBlocked(root, refreshed.id, skillReferenceError);
    return { runId: refreshed.runId ?? refreshed.id, execution: "blocked" };
  }

  let requiredSkillSection = "";
  if (step.skill) {
    try {
      requiredSkillSection = await loadRequiredSkillSection(root, step);
    } catch {
      await markTaskBlocked(
        root,
        refreshed.id,
        `Workflow step "${step.id}" requires skill "${step.skill}" but it could not be loaded.`
      );
      return { runId: refreshed.runId ?? refreshed.id, execution: "blocked" };
    }
  }

  const stablePrefix = buildStableAgentPrefix(
    root,
    refreshed,
    skills,
    workflowId,
    step,
    requiredSkillSection
  );

  let prompt: string;
  let routing: ResolvedRouting | undefined;
  let conversation = false;

  if (step.kind === "conversation") {
    conversation = true;
    const agentResult = await resolveTurnAgent(root, refreshed, step.id);
    if ("execution" in agentResult) return agentResult;
    routing = agentResult;
    prompt = operatorFollowup
      ? buildConversationFollowupPrompt(refreshed, step, workspace.cwd, root, stablePrefix, memorySection)
      : buildConversationPrompt(refreshed, step, workspace.cwd, root, stablePrefix, memorySection);
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

    const authorStepId = findArtifactProducingStepId(workflow, step.id) ?? step.id;
    const reviewerResult = await resolveTurnAgent(root, refreshed, step.id);
    if ("execution" in reviewerResult) return reviewerResult;
    const reviewerRouting = reviewerResult;
    const authorResult = await resolveTurnAgent(root, refreshed, authorStepId);
    if ("execution" in authorResult) return authorResult;
    const authorRouting = await persistedAuthorRouting(root, refreshed.id, authorStepId, authorResult);
    const authorAgent = authorRouting.toolId;
    const independenceViolation = reviewerIndependenceViolation({
      required: resolveReviewerIndependence(step, resolveReviewProfile(step)),
      author: authorRouting,
      reviewer: reviewerRouting,
      authorStepId,
      reviewerStepId: step.id,
      workflowId,
      ...(refreshed.stageModelPoolOverrides
        ? { taskModelPoolOverrides: refreshed.stageModelPoolOverrides }
        : {}),
      workflowModelPoolOverrides: await loadStageModelPoolOverrides(root)
    });
    if (independenceViolation) {
      await markTaskBlocked(root, refreshed.id, independenceViolation);
      return { runId: refreshed.runId ?? refreshed.id, execution: "blocked" };
    }
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
      memorySection,
      step,
      supportingEvidence: gatherReviewSupportingEvidence({
        task: refreshed,
        step,
        workflow,
        harnessRoot: root,
        excludeAuthorReply: authorReply
      })
    });
    await markTaskRunning(root, refreshed.id, { startedAt: refreshed.startedAt ?? now() });
    const reviewerRunner =
      options?.reviewerRunner ??
      options?.runner ??
      (await createRunnerForRouting(root, reviewerRouting));
    const reviewerTask = (await getTask(root, refreshed.id))!;
    const reviewerRoutingContext = await executionRoutingContext(root, reviewerTask, step.id, workspace.cwd);
    return executeAgentTurn(root, {
      task: reviewerTask,
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
      reviewer: { round: (refreshed.reviewRounds ?? 0) + 1 },
      enabledExtensionIds: reviewerRouting.extensions,
      extensionEntries: reviewerRouting.extensionEntries,
      ...(reviewerRoutingContext ? { routingContext: reviewerRoutingContext } : {})
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
            workflowId,
            step,
            memorySection,
            describeCheckPlan(await planProjectChecks(root, refreshed.projectId, workspace.cwd)),
            requiredSkillSection
          )
        : buildFollowupPrompt(refreshed, root, stablePrefix, memorySection);
    }
    if (shouldAttachWorkspaceArtifacts(step.skill)) {
      const artifacts = await gatherWorkspaceArtifacts(workspace);
      prompt += `\n\n${formatWorkspaceArtifactsSection(artifacts)}`;
    }
  }

  await markTaskRunning(root, refreshed.id, { startedAt: refreshed.startedAt ?? now() });
  const resolvedRunner =
    options?.runner ??
    (await createRunnerForRouting(root, routing!, {
      stepContext: {
        stepKind: step.kind,
        reviewer: false,
        checksRemediation: false
      }
    }));
  const executionTask = (await getTask(root, refreshed.id))!;
  const routingContext = await executionRoutingContext(root, executionTask, step.id, workspace.cwd);
  return executeAgentTurn(root, {
    task: executionTask,
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
    ...(conversation ? { conversation } : {}),
    enabledExtensionIds: routing!.extensions,
    extensionEntries: routing!.extensionEntries,
    ...(routingContext ? { routingContext } : {})
  });
}
