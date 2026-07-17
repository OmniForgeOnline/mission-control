import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";


import { runHooks } from "../core/review/hooks.ts";
import { updateRun } from "../core/tasks/runs.ts";
import { appendRunEvent, type RunEventInput } from "../core/runs/events.ts";
import { isLiveRunner } from "../runners/types.ts";
import {
  formatReviewRemediation,
  parseReviewerVerdict
} from "../core/review/code-review.ts";
import { inspectPostTurnGit } from "../core/worktrees/worktrees.ts";
import {
  addTaskMessage,
  advanceTaskWorkflowStep,
  getTask,
  markTaskBlocked,
  markTaskCompleted,
  markTaskPaused,
  markTaskRunning,
  patchTaskExecution,
  routeTaskToImplementationStep,
  updateTask
} from "../core/tasks/tasks.ts";
import { deriveExecution } from "../core/tasks/status.ts";
import {
  agentSessionFromTurn,
  canResumeAgentSession,
  clearAgentSession,
  hashStableInstructions
} from "../core/agents/session.ts";
import { sanitizeAgentMessageBody } from "../core/agents/output.ts";
import {
  extractFinalPlan,
  normalizeReplyForPlanExtraction
} from "../core/workflows/prompts.ts";
import {
  findRepoRemediationStepId,
  getStep,
  effortForRunner,
  stepModifiesRepo,
  type WorkflowDefinition
} from "../core/workflows/index.ts";
import type { HarnessMessage, HarnessRun, HarnessTask } from "../core/types.ts";
import type { AgentActivity, AgentRunner } from "../runners/types.ts";
import { clearInflightTurn } from "../runtime/sessions.ts";
import { captureLessonFromReply } from "../memory/auto-capture.ts";
import { captureTaskCompletion } from "../memory/auto-capture.ts";
import { markPoolExhaustedFromFailure } from "../core/agents/config/usage-store.ts";
import { looksLikeFinalAnswer } from "./final-answer.ts";
import { advanceAuthorTurnWorkflow, scheduleAuthorRerun, scheduleReviewerTurn } from "./agent-turn.ts";
import {
  runInlineChecksRemediationLoop
} from "./remediation.ts";
import { now, type RunTurnInternal, type TurnSummary } from "./types.ts";
import {
  describeAuthorGitHandoffFailure,
  markMergeRequestReadyAtHandoff,
  rerunAuthorForGitHandoffFailure
} from "./author-handoff.ts";

function turnResult(runId: string, task: HarnessTask): TurnSummary {
  return { runId, execution: deriveExecution(task) };
}

export async function finalizeCompletedTaskMemory(root: string, taskId: string, replyBody: string): Promise<void> {
  try {
    const task = await getTask(root, taskId);
    if (!task || task.resolution !== "completed") return;
    await captureTaskCompletion(root, task, replyBody);
  } catch {
    /* memory capture must never block workflow advancement */
  }
}

export interface CompleteAgentTurnParams {
  root: string;
  internal: RunTurnInternal;
  workflow: WorkflowDefinition;
  run: HarnessRun;
  runDir: string;
  logPath: string;
  resolvedRunner: AgentRunner;
  heartbeat: ReturnType<typeof setInterval>;
  onActivity: (activity: AgentActivity) => void;
  onSessionId: (sessionId: string) => void;
}

export async function completeAgentTurn(params: CompleteAgentTurnParams): Promise<TurnSummary> {
  const { root, internal, workflow, run, runDir, logPath, resolvedRunner, heartbeat, onActivity, onSessionId } = params;
  let { task, prompt, workspace, options, turnNumber, step } = internal;

  let logWrite = Promise.resolve();
  const onOutput = (chunk: string) => {
    logWrite = logWrite.then(() => appendFile(logPath, chunk, "utf8"));
  };

  let eventWrite = Promise.resolve();
  const onEvent = (input: RunEventInput) => {
    eventWrite = eventWrite.then(() => appendRunEvent(root, run.id, input).then(() => undefined));
  };

  const effort = internal.supportsEffort
    ? effortForRunner(workflow, step.id, {
        stageOverride: task.stageEffortOverrides?.[step.id],
        taskEffort: task.effort
      })
    : undefined;
  const runnerTask: HarnessTask =
    internal.supportsEffort && effort ? { ...task, effort } : task;

  const stableHash = hashStableInstructions(prompt);
  const sessionContext = {
    agent: internal.agent,
    modelPool: internal.modelPoolId,
    conversation: Boolean(internal.conversation),
    stableHash
  };
  const sessionId =
    internal.reviewer || !canResumeAgentSession(task, sessionContext)
      ? undefined
      : task.agentSessionId;

  // Live (persistent-stdin) execution is limited to authoring/conversation
  // steps on capable runners; review/checks/remediation stay batch for V1.
  const liveStep = !internal.reviewer && (step.kind === "agent_turn" || step.kind === "conversation");
  const live = liveStep && isLiveRunner(resolvedRunner);

  const result = await resolvedRunner.runTurn({
    task: runnerTask,
    prompt,
    cwd: workspace.cwd,
    ...(sessionId !== undefined ? { sessionId } : {}),
    turnNumber,
    ...(internal.conversation ? { mode: "plan" as const } : {}),
    ...(live ? { live: true } : {}),
    onOutput,
    onActivity,
    onSessionId,
    onEvent,
    harnessRoot: root,
    runId: run.id,
    runDir,
    ...(internal.enabledExtensionIds !== undefined ? { enabledExtensionIds: internal.enabledExtensionIds } : {}),
    ...(internal.extensionEntries !== undefined ? { extensionEntries: internal.extensionEntries } : {})
  });

  await logWrite;
  clearInflightTurn(task.id, run.id);
  clearInterval(heartbeat);

  const completedAt = now();
  const isAborted =
    result.blockedReason === "Stopped by operator" ||
    result.blockedReason === "Stopped by user" ||
    Boolean(result.blockedReason?.toLowerCase().includes("stopped"));
  const turnSucceeded = result.exitCode === 0;
  const replyBody = (result.reply || "").trim();

  // Close out the canonical event stream so SSE clients see a terminal event.
  await eventWrite;
  await appendRunEvent(
    root,
    run.id,
    turnSucceeded && !isAborted
      ? { type: "done", exitCode: result.exitCode }
      : {
          type: "error",
          exitCode: result.exitCode,
          ...(result.blockedReason !== undefined ? { text: result.blockedReason } : {})
        }
  );

  if (!turnSucceeded && !isAborted) {
    await markPoolExhaustedFromFailure(root, internal.agent, internal.modelPoolId, result.blockedReason);
  }

  if (!internal.reviewer && !internal.checksRemediation && !internal.conversation) {
    const hookBlockComplete = await runHooks(workspace.cwd, "on_turn_complete", {
      task: { id: task.id, title: task.title, description: task.description, agent: internal.agent },
      runId: run.id,
      reply: replyBody,
      exitCode: result.exitCode,
      workspace: { cwd: workspace.cwd, isRepo: workspace.isRepo }
    }, onOutput);
    if (hookBlockComplete) {
      await updateRun(root, run.id, { status: "blocked", completedAt, blockedReason: hookBlockComplete.reason });
      const blocked = await markTaskBlocked(root, task.id, hookBlockComplete.reason, {
        completedAt,
        runId: run.id
      });
      return turnResult(run.id, blocked);
    }
  }

  if (replyBody) {
    const author: HarnessMessage["author"] = internal.reviewer ? "system" : "agent";
    const prefix = internal.reviewer
      ? `### Reviewer (${internal.agent}) round ${internal.reviewer.round}\n\n`
      : internal.checksRemediation
      ? `### Checks remediation round ${internal.checksRemediation.round}\n\n`
      : internal.conversation
      ? `### Planning turn ${turnNumber}\n\n`
      : "";
    const messageBody = sanitizeAgentMessageBody(`${prefix}${replyBody}`).trim();
    if (messageBody) {
      await addTaskMessage(root, task.id, {
        author,
        body: messageBody,
        stepId: step.id
      });
    }
  } else if (!turnSucceeded) {
    await addTaskMessage(root, task.id, {
      author: "system",
      body: `Turn ${turnNumber} failed: ${result.blockedReason ?? `exit ${result.exitCode}`}`,
      stepId: step.id
    });
  }

  await writeFile(path.join(runDir, "summary.md"), `${replyBody || result.blockedReason || "(no reply)"}\n`, "utf8");

  const runStatus = isAborted ? "paused" : turnSucceeded ? "completed" : "blocked";
  await updateRun(root, run.id, {
    status: runStatus,
    completedAt,
    command: result.command,
    exitCode: result.exitCode,
    ...(result.blockedReason !== undefined ? { blockedReason: result.blockedReason } : {}),
    artifacts: ["prompt.md", "summary.md", "log.txt"]
  });

  const nextSessionId =
    result.sessionId ?? (canResumeAgentSession(task, sessionContext) ? task.agentSessionId : undefined);
  const sessionUpdates = nextSessionId
    ? agentSessionFromTurn(nextSessionId, internal.agent, Boolean(internal.conversation), internal.modelPoolId, stableHash)
    : clearAgentSession();

  const baseUpdates: Partial<HarnessTask> = {
    runId: run.id,
    ...sessionUpdates,
    turnCount: turnNumber,
    updatedAt: now()
  };
  const baseClear: Array<keyof HarnessTask> = ["currentActivity"];

  // Interactive PTY turns are completed by the operator (Done/Block), not by
  // final-answer heuristics or process exit alone.
  const interactiveDone =
    result.interactive === true && result.operatorOutcome === "done" && turnSucceeded && !isAborted;

  if (internal.conversation) {
    const plan = extractFinalPlan(normalizeReplyForPlanExtraction(replyBody, internal.agent));
    // Operator Done in interactive mode advances even without a parseable plan
    // block — the human is the completion signal.
    if ((plan || interactiveDone) && turnSucceeded && !isAborted) {
      await advanceTaskWorkflowStep(root, task.id);
      const updated = await patchTaskExecution(
        root,
        task.id,
        { blockedReason: null },
        baseUpdates,
        { clear: baseClear }
      );
      void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
      return turnResult(run.id, updated);
    }
    const updated = isAborted
      ? await markTaskPaused(root, task.id, {
          ...baseUpdates,
          blockedReason: result.blockedReason ?? "Stopped by operator"
        })
      : turnSucceeded
      ? await patchTaskExecution(
          root,
          task.id,
          { blockedReason: null, completedAt: null },
          baseUpdates,
          { clear: baseClear }
        )
      : await markTaskBlocked(root, task.id, result.blockedReason ?? "Turn failed", {
          ...baseUpdates,
          completedAt
        });
    void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
    return turnResult(run.id, updated);
  }

  if (internal.reviewer) {
    const verdict = parseReviewerVerdict(replyBody);
    await updateTask(root, task.id, (current) => {
      const { currentActivity: _activity, ...cleared } = current;
      return {
        ...cleared,
        reviewState: verdict.decision,
        reviewRounds: (current.reviewRounds ?? 0) + 1,
        ...baseUpdates
      };
    });

    if (verdict.decision === "approved") {
      const advanced = await advanceTaskWorkflowStep(root, task.id, "approved");
      const nextStep = getStep(workflow, advanced.workflowRun!.currentStepId);
      if (nextStep.kind === "terminal") {
        // Review accepted the work: this is the only point at which the draft
        // MR/PR becomes ready for review. No-op when there is no merge request.
        await markMergeRequestReadyAtHandoff(
          root,
          advanced,
          workspace.repoPath ?? advanced.repoPath,
          nextStep.id
        );
        const done = await markTaskCompleted(root, task.id, { ...baseUpdates, completedAt });
        void finalizeCompletedTaskMemory(root, task.id, replyBody);
        return turnResult(run.id, done);
      }
      const updated = await patchTaskExecution(
        root,
        task.id,
        { blockedReason: null },
        baseUpdates,
        { clear: baseClear }
      );
      return turnResult(run.id, updated);
    }

    if (
      verdict.decision === "changes_requested" &&
      !isAborted &&
      turnSucceeded
    ) {
      const remediationPrompt = formatReviewRemediation(verdict);
      const implementationStepId = findRepoRemediationStepId(workflow);
      if (!implementationStepId) {
        const blocked = await markTaskBlocked(
          root,
          task.id,
          "Reviewer requested changes but workflow has no implementation step.",
          { ...baseUpdates, completedAt }
        );
        return turnResult(run.id, blocked);
      }
      await addTaskMessage(root, task.id, {
        author: "system",
        body: "Reviewer asked for changes; rerunning author.",
        stepId: step.id
      });
      await routeTaskToImplementationStep(root, task.id, "changes_requested");
      await markTaskRunning(root, task.id, baseUpdates);
      return scheduleAuthorRerun(root, task.id, remediationPrompt, options, implementationStepId);
    }

    const reviewRound = (task.reviewRounds ?? 0) + 1;
    const blocked = await markTaskBlocked(
      root,
      task.id,
      verdict.parseFailed
        ? `Reviewer verdict JSON could not be parsed after ${reviewRound} round(s).`
        : `Reviewer returned unclear verdict after ${reviewRound} round(s).`,
      { ...baseUpdates, completedAt }
    );
    return turnResult(run.id, blocked);
  }

  if (isAborted) {
    const paused = await markTaskPaused(root, task.id, {
      ...baseUpdates,
      blockedReason: result.blockedReason ?? "Stopped by operator"
    });
    return turnResult(run.id, paused);
  }

  if (!turnSucceeded) {
    const blocked = await markTaskBlocked(root, task.id, result.blockedReason ?? "Turn failed", {
      ...baseUpdates,
      completedAt
    });
    return turnResult(run.id, blocked);
  }

  const successClear: Array<keyof HarnessTask> = [...baseClear, "blockedReason"];

  task = await updateTask(root, task.id, (current) => ({
    ...current,
    ...baseUpdates,
    updatedAt: now()
  }));

  const gitState = await inspectPostTurnGit(workspace);
  const repoAuthorStep = workspace.isRepo && stepModifiesRepo(step) && !internal.reviewer && !internal.conversation;
  const authorHandoffFailure =
    repoAuthorStep && looksLikeFinalAnswer(replyBody)
      ? describeAuthorGitHandoffFailure(workspace.branch, gitState)
      : null;
  if (authorHandoffFailure) {
    void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
    return rerunAuthorForGitHandoffFailure(
      root,
      task,
      authorHandoffFailure,
      options,
      step.id,
      baseUpdates,
      completedAt
    );
  }

  let pushedAt: string | undefined;
  let commitCount: number | undefined;
  let scheduleReview = false;

  // Push-flow heuristics only apply on isolated harness worktrees (branch set).
  // Plan/conversation steps may run in the destination project for context without
  // a harness branch; do not treat the main checkout as a completed author push.
  if (
    gitState &&
    workspace.branch &&
    gitState.commitCount > 0 &&
    !gitState.hasUnpushedCommits &&
    !gitState.hasUncommittedChanges
  ) {
    pushedAt = completedAt;
    commitCount = gitState.commitCount;
    const nextAfterPush = step.next ? getStep(workflow, step.next) : null;
    scheduleReview = nextAfterPush?.kind === "review";
  } else if (looksLikeFinalAnswer(replyBody)) {
    // no push, but agent declared done
  } else {
    if (gitState && gitState.commitCount > 0 && gitState.hasUnpushedCommits) {
      commitCount = gitState.commitCount;
    }
    const nextCommitCount = commitCount ?? task.commitCount;
    const updated = await patchTaskExecution(
      root,
      task.id,
      { blockedReason: null },
      {
        ...baseUpdates,
        ...(nextCommitCount !== undefined ? { commitCount: nextCommitCount } : {})
      },
      { clear: successClear }
    );
    void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
    return turnResult(run.id, updated);
  }

  await updateTask(root, task.id, (current) => {
    const { currentActivity: _activity, ...cleared } = current;
    const nextPushedAt = pushedAt ?? current.pushedAt;
    const nextCommitCount = commitCount ?? current.commitCount;
    return {
      ...cleared,
      ...baseUpdates,
      ...(nextPushedAt !== undefined ? { pushedAt: nextPushedAt } : {}),
      ...(nextCommitCount !== undefined ? { commitCount: nextCommitCount } : {})
    };
  });

  // Run the inline check loop only on the implementation/authoring step.
  // Conversation, reviewer, and git-handoff turns never reach this path (they
  // return earlier above); among agent_turn steps, non-authoring turns (analysis,
  // research, content) do not own the work the checks validate, so a failing
  // project check must not hold them. stepModifiesRepo identifies the authoring
  // step for both repo workspaces (repo-modifying step) and non-repo ones
  // (pr-driven-execution). The loop then decides internally how the outcome gates
  // each workspace type: a repo workspace on a repo-modifying step gets the full
  // remediation gate; a non-repo workspace runs the detected checks once and
  // blocks on failure (posting the outcome first), so a project with detected
  // commands can never complete past a failure.
  if (stepModifiesRepo(step)) {
    const checksLoop = await runInlineChecksRemediationLoop({
      root,
      task,
      workspace,
      workflow,
      step,
      internal,
      resolvedRunner,
      run,
      runDir,
      baseUpdates,
      baseClear,
      completedAt,
      onOutput,
      onActivity,
      onSessionId
    });
    if (!checksLoop.ok) {
      return checksLoop.summary;
    }
    task = checksLoop.task;
    if (task.turnCount !== undefined) {
      baseUpdates.turnCount = task.turnCount;
    }
    const checksPassed = checksLoop.checks.skipped || checksLoop.checks.pass;
    if ((task.checkRound || task.remediationStreak) && checksPassed) {
      await updateTask(root, task.id, (current) => {
        const {
          lastCheckFailure: _failure,
          remediationStreak: _streak,
          lastRemediationFingerprint: _fp,
          ...rest
        } = current;
        return { ...rest, checkRound: 0, updatedAt: now() };
      });
    }
  }

  if (scheduleReview) {
    await patchTaskExecution(root, task.id, { blockedReason: null }, baseUpdates, { clear: baseClear });
    return scheduleReviewerTurn(root, task.id, options);
  }

  const shouldAdvanceWorkflow =
    (interactiveDone || pushedAt || looksLikeFinalAnswer(replyBody)) && !scheduleReview;
  if (shouldAdvanceWorkflow) {
    return advanceAuthorTurnWorkflow(root, {
      task,
      workflow,
      run,
      replyBody,
      workspace,
      ...(options !== undefined ? { options } : {}),
      baseUpdates,
      statusClear: successClear,
      runId: run.id,
      completedAt
    });
  }

  const updated = await patchTaskExecution(root, task.id, { blockedReason: null }, baseUpdates, {
    clear: baseClear
  });
  void captureLessonFromReply(root, task, run, replyBody).catch(() => {});
  return turnResult(run.id, updated);
}
