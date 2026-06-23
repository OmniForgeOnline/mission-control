import crypto from "node:crypto";

import { sanitizeAgentMessageBody } from "../core/agents/output.ts";
import { canResumeAgentSession, agentSessionFromTurn, hashStableInstructions } from "../core/agents/session.ts";
import {
  buildCheckRemediationPrompt,
  describeChecksOutcome,
  runChecks,
  summarizeFailures,
  type CheckSummary
} from "../core/review/checks.ts";
import {
  effortForRunner,
  stepModifiesRepo,
  type WorkflowDefinition,
  type WorkflowStep
} from "../core/workflows/index.ts";
import type { PreparedWorkspace } from "../core/worktrees/worktrees.ts";
import { addTaskMessage, markTaskBlocked, markTaskRunning, updateTask } from "../core/tasks/tasks.ts";
import type { HarnessRun, HarnessTask } from "../core/types.ts";
import type { AgentActivity, AgentRunner, AgentTurnResult } from "../runners/types.ts";
import { now, type RunTurnInternal, type TurnSummary } from "./types.ts";

/** Same error repeated this many times in a row; stop to avoid infinite spin. */
export const REMEDIATION_STAGNATION_LIMIT = 5;
/** Hard safety cap on remediation attempts in one completion pass. */
export const REMEDIATION_ABSOLUTE_LIMIT = 50;

export function fingerprintRemediationError(message: string): string {
  const normalized = message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/:\d+:\d+/g, ":<line>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function shouldStopRemediation(round: number, sameErrorStreak: number): boolean {
  return sameErrorStreak >= REMEDIATION_STAGNATION_LIMIT || round >= REMEDIATION_ABSOLUTE_LIMIT;
}

/**
 * Post the project-aware check outcome as a task message so operators can see,
 * for every implementation step, exactly which checks ran, which were skipped
 * because the tooling was unavailable, and whether anything was validated at all.
 */
async function postChecksOutcomeMessage(
  root: string,
  task: HarnessTask,
  checks: CheckSummary
): Promise<void> {
  await addTaskMessage(root, task.id, {
    author: "system",
    body: describeChecksOutcome(checks),
    ...(task.workflowRun?.currentStepId ? { stepId: task.workflowRun.currentStepId } : {})
  });
}

export interface InlineRemediationParams {
  root: string;
  task: HarnessTask;
  workspace: PreparedWorkspace;
  workflow: WorkflowDefinition;
  step: WorkflowStep;
  internal: RunTurnInternal;
  resolvedRunner: AgentRunner;
  run: HarnessRun;
  runDir: string;
  prompt: string;
  remediationRound: number;
  onOutput: (chunk: string) => void;
  onActivity: (activity: AgentActivity) => void;
  onSessionId: (sessionId: string) => void;
}

export async function runInlineRemediationTurn(params: InlineRemediationParams): Promise<{
  turnSucceeded: boolean;
  replyBody: string;
  blockedReason?: string;
  task: HarnessTask;
}> {
  const { root, internal, resolvedRunner, run, workspace, step, onOutput, onActivity, onSessionId } = params;
  let task = params.task;
  const turnNumber = (task.turnCount ?? 0) + 1;
  const effort = internal.supportsEffort
    ? effortForRunner(params.workflow, step.id, {
        stageOverride: task.stageEffortOverrides?.[step.id],
        taskEffort: task.effort
      })
    : undefined;
  const runnerTask: HarnessTask =
    internal.supportsEffort && effort ? { ...task, effort } : task;

  const stableHash = hashStableInstructions(params.prompt);
  const sessionContext = { agent: internal.agent, modelPool: internal.modelPoolId, conversation: false, stableHash };
  const sessionId = canResumeAgentSession(task, sessionContext) ? task.agentSessionId : undefined;

  const result: AgentTurnResult = await resolvedRunner.runTurn({
    task: runnerTask,
    prompt: params.prompt,
    cwd: workspace.cwd,
    ...(sessionId !== undefined ? { sessionId } : {}),
    turnNumber,
    onOutput,
    onActivity,
    onSessionId,
    harnessRoot: root,
    runId: run.id,
    runDir: params.runDir
  });

  const replyBody = (result.reply || "").trim();
  if (replyBody) {
    await addTaskMessage(root, task.id, {
      author: "agent",
      body: sanitizeAgentMessageBody(`### Remediation attempt ${params.remediationRound}\n\n${replyBody}`),
      ...(task.workflowRun?.currentStepId ? { stepId: task.workflowRun.currentStepId } : {})
    });
  }

  const sessionUpdates = result.sessionId
    ? agentSessionFromTurn(result.sessionId, internal.agent, false, internal.modelPoolId, stableHash)
    : {};
  task = await updateTask(root, task.id, (current) => ({
    ...current,
    turnCount: turnNumber,
    ...sessionUpdates,
    updatedAt: now()
  }));

  return {
    turnSucceeded: result.exitCode === 0,
    replyBody,
    ...(result.blockedReason !== undefined ? { blockedReason: result.blockedReason } : {}),
    task
  };
}

export interface InlineChecksRemediationLoopParams {
  root: string;
  task: HarnessTask;
  workspace: PreparedWorkspace;
  workflow: WorkflowDefinition;
  step: WorkflowStep;
  internal: RunTurnInternal;
  resolvedRunner: AgentRunner;
  run: HarnessRun;
  runDir: string;
  baseUpdates: Partial<HarnessTask>;
  baseClear: Array<keyof HarnessTask>;
  completedAt: string;
  onOutput: (chunk: string) => void;
  onActivity: (activity: AgentActivity) => void;
  onSessionId: (sessionId: string) => void;
}

export type InlineChecksRemediationLoopResult =
  | { ok: true; checks: CheckSummary; task: HarnessTask }
  | { ok: false; summary: TurnSummary };

export async function runInlineChecksRemediationLoop(
  params: InlineChecksRemediationLoopParams
): Promise<InlineChecksRemediationLoopResult> {
  if (!params.workspace.isRepo || !stepModifiesRepo(params.step)) {
    // Non-repo (or non-repo-modifying) workspaces get a single check run, not the
    // remediation loop. The implementation prompt still promises "the harness
    // re-runs these exact commands and blocks on failure", so a detected check
    // that fails must hold the workflow here rather than advancing after only
    // posting the outcome. noChecks and validated outcomes complete as usual.
    const checks = await runChecks(params.workspace.cwd, params.onOutput);
    await postChecksOutcomeMessage(params.root, params.task, checks);
    if (!checks.pass) {
      await markTaskBlocked(params.root, params.task.id, "Mechanical checks failed");
      return { ok: false, summary: { runId: params.run.id, execution: "blocked" } };
    }
    return { ok: true, checks, task: params.task };
  }

  let { task } = params;
  let checkRound = task.checkRound ?? 0;
  let sameErrorStreak = 0;
  let lastFingerprint = "";

  for (;;) {
    const checks = await runChecks(params.workspace.cwd, params.onOutput);
    if (checks.skipped || checks.pass) {
      await postChecksOutcomeMessage(params.root, task, checks);
      return { ok: true, checks, task };
    }

    checkRound++;
    const failureSummary = summarizeFailures(checks);
    const fingerprint = fingerprintRemediationError(failureSummary);
    sameErrorStreak = fingerprint === lastFingerprint ? sameErrorStreak + 1 : 1;
    lastFingerprint = fingerprint;

    if (shouldStopRemediation(checkRound, sameErrorStreak)) {
      const blockedReason =
        sameErrorStreak >= REMEDIATION_STAGNATION_LIMIT
          ? `Mechanical checks blocked: same failure repeated ${sameErrorStreak} times`
          : `Mechanical checks blocked after ${checkRound} remediation attempts`;
      await markTaskBlocked(params.root, task.id, blockedReason);
      return { ok: false, summary: { runId: params.run.id, execution: "blocked" } };
    }

    await updateTask(params.root, task.id, (current) => ({
      ...current,
      checkRound,
      lastCheckFailure: failureSummary,
      updatedAt: now()
    }));

    await addTaskMessage(params.root, task.id, {
      author: "system",
      body: "Mechanical checks failed. Re-running author with the failure attached.",
      ...(task.workflowRun?.currentStepId ? { stepId: task.workflowRun.currentStepId } : {})
    });
    await markTaskRunning(params.root, task.id, params.baseUpdates);

    const remed = await runInlineRemediationTurn({
      root: params.root,
      task,
      workspace: params.workspace,
      workflow: params.workflow,
      step: params.step,
      internal: params.internal,
      resolvedRunner: params.resolvedRunner,
      run: params.run,
      runDir: params.runDir,
      prompt: buildCheckRemediationPrompt(failureSummary, checkRound),
      remediationRound: checkRound,
      onOutput: params.onOutput,
      onActivity: params.onActivity,
      onSessionId: params.onSessionId
    });
    task = remed.task;

    if (!remed.turnSucceeded) {
      await markTaskBlocked(
        params.root,
        task.id,
        remed.blockedReason ?? "Remediation turn failed",
        { ...params.baseUpdates, completedAt: params.completedAt }
      );
      return { ok: false, summary: { runId: params.run.id, execution: "blocked" } };
    }
  }
}
