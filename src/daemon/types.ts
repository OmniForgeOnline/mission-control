import type { AgentRunner } from "../runners/types.ts";
import type { ExecutionState, HarnessTask } from "../core/types.ts";
import type { ModelPoolId, ToolId } from "../core/types.ts";
import type { PreparedWorkspace } from "../core/worktrees/worktrees.ts";
import type { WorkflowStep } from "../core/workflows/index.ts";
import type { createRun } from "../core/tasks/runs.ts";
import type { WorkflowDefinition } from "../core/workflows/index.ts";

export interface ProcessOptions {
  runner?: AgentRunner;
  reviewerRunner?: AgentRunner;
  wait?: boolean;
}

export interface TurnSummary {
  runId: string;
  execution: ExecutionState;
}

export interface RunTurnInternal {
  task: HarnessTask;
  prompt: string;
  agent: ToolId;
  modelPoolId: ModelPoolId;
  supportsEffort: boolean;
  workspace: PreparedWorkspace;
  resolvedRunner: AgentRunner;
  options?: ProcessOptions;
  turnNumber: number;
  isFirstTurn: boolean;
  step: WorkflowStep;
  reviewer?: { round: number };
  checksRemediation?: { round: number };
  conversation?: boolean;
}

export interface AdvanceAuthorTurnContext {
  task: HarnessTask;
  workflow: WorkflowDefinition;
  run: Awaited<ReturnType<typeof createRun>>;
  replyBody: string;
  workspace: PreparedWorkspace;
  options?: ProcessOptions;
  baseUpdates: Partial<HarnessTask>;
  statusClear?: Array<keyof HarnessTask>;
  runId: string;
  completedAt: string;
}

export const MAX_RESUME_ATTEMPTS = 3;

export { isTaskRunnable as isTaskDaemonRunnable } from "../core/tasks/status.ts";

export function now(): string {
  return new Date().toISOString();
}
