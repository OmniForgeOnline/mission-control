import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, readJsonFile, writeJsonFile } from "../core/infra/fs.ts";
import { listProposalTasks } from "../core/proposals/proposals.ts";
import { createRun, listAllRuns, updateRun } from "../core/tasks/runs.ts";
import { resolveHarnessDefaultRouting } from "../core/agents/stage-agents.ts";
import { loadAgentConfig } from "../core/agents/config/store.ts";
import { resolveLaunchByIds } from "../core/agents/config/launch.ts";
import { markPoolExhaustedFromFailure } from "../core/agents/config/usage-store.ts";
import { formatNoRouteMessage } from "../core/agents/config/optimizer.ts";
import type { ModelPoolId, ToolId, HarnessTask } from "../core/types.ts";
import { clearInflightTurn, registerInflightTurn } from "../runtime/sessions.ts";
import { createAgentRunner } from "../runners/index.ts";
import type { AgentRunner } from "../runners/types.ts";

export const AUTONOMY_AGENT_STALE_LOCK_MS = 30 * 60 * 1000;

export interface AutonomyAgentState {
  lastRunAt?: string;
  sessionId?: string;
  sessionAgent?: ToolId;
  sessionModelPool?: ModelPoolId;
  turnCount?: number;
  /** ISO timestamp; set before agent spawn, cleared after turn completes. */
  runningSince?: string;
}

export type AutonomyAgentLockResult =
  | { acquired: true }
  | { acquired: false; activeRunId?: string };

export interface AutonomyAgentTurnResult {
  runId: string;
  status: "completed" | "blocked";
  summary: string;
  proposalsCreated: number;
}

export interface AutonomyAgentJobSpec {
  taskId: string;
  taskTitle: string;
  projectId?: string;
  repoPath?: string;
  stateFileName: string;
  skipSummary: string;
  completedSummary: (turnNumber: number, proposalsCreated: number, extra?: string) => string;
  blockedSummary: (reason: string) => string;
  buildContext: (root: string) => Promise<string>;
  buildPrompt: (context: string) => string;
  /** Return a summary to exit before spawning an agent. */
  preflight?: (root: string) => Promise<string | null>;
  /** Called after a completed or blocked agent turn. */
  afterTurn?: (root: string) => Promise<void>;
}

export interface RunAutonomyAgentOptions {
  runner?: AgentRunner;
}

function now(): string {
  return new Date().toISOString();
}

function statePath(root: string, fileName: string): string {
  return path.join(root, "data", "state", fileName);
}

async function readState(root: string, fileName: string): Promise<AutonomyAgentState> {
  return readJsonFile<AutonomyAgentState>(statePath(root, fileName), {});
}

async function writeState(root: string, fileName: string, state: AutonomyAgentState): Promise<void> {
  await writeJsonFile(statePath(root, fileName), state);
}

function findActiveRun(runs: Awaited<ReturnType<typeof listAllRuns>>, taskId: string) {
  return runs.find((run) => run.taskId === taskId && run.status === "running");
}

async function acquireLock(
  root: string,
  spec: Pick<AutonomyAgentJobSpec, "taskId" | "stateFileName" | "skipSummary">
): Promise<AutonomyAgentLockResult> {
  const runs = await listAllRuns(root);
  const activeRun = findActiveRun(runs, spec.taskId);
  if (activeRun) {
    console.log(`${spec.taskId} skipped: already running (${activeRun.id})`);
    return { acquired: false, activeRunId: activeRun.id };
  }

  let state = await readState(root, spec.stateFileName);
  if (state.runningSince) {
    const ageMs = Date.now() - Date.parse(state.runningSince);
    if (ageMs < AUTONOMY_AGENT_STALE_LOCK_MS) {
      console.log(`${spec.taskId} skipped: already running (${state.runningSince})`);
      return { acquired: false };
    }
    console.log(`${spec.taskId} stale guard expired (runningSince=${state.runningSince}), proceeding`);
    const { runningSince: _stale, ...cleared } = state;
    state = cleared;
    await writeState(root, spec.stateFileName, state);
  }

  await writeState(root, spec.stateFileName, { ...state, runningSince: now() });
  return { acquired: true };
}

async function releaseLock(root: string, stateFileName: string): Promise<void> {
  const state = await readState(root, stateFileName);
  if (!state.runningSince) return;
  const { runningSince: _active, ...released } = state;
  await writeState(root, stateFileName, released);
}

export async function runAutonomyAgentTurn(
  root: string,
  spec: AutonomyAgentJobSpec,
  options?: RunAutonomyAgentOptions
): Promise<AutonomyAgentTurnResult> {
  const lock = await acquireLock(root, spec);
  if (!lock.acquired) {
    return {
      runId: lock.activeRunId ?? "",
      status: "completed",
      proposalsCreated: 0,
      summary: spec.skipSummary
    };
  }

  try {
    if (spec.preflight) {
      const earlySummary = await spec.preflight(root);
      if (earlySummary) {
        return { runId: "", status: "completed", proposalsCreated: 0, summary: earlySummary };
      }
    }

    const routing = await resolveHarnessDefaultRouting(root);
    if (!routing) {
      return {
        runId: "",
        status: "blocked",
        proposalsCreated: 0,
        summary: formatNoRouteMessage(await loadAgentConfig(root), "author")
      };
    }
    const agent = routing.toolId;
    const state = await readState(root, spec.stateFileName);
    const proposalsBefore = (await listProposalTasks(root)).length;
    const context = await spec.buildContext(root);
    const prompt = spec.buildPrompt(context);
    const startedAt = now();
    const turnNumber = (state.turnCount ?? 0) + 1;
    const modelPool: ModelPoolId = routing.modelPoolId;
    console.log(`autonomy: ${spec.taskId} -> ${agent}/${modelPool} (turn ${turnNumber})`);

    const run = await createRun(root, {
      taskId: spec.taskId,
      taskTitle: spec.taskTitle,
      ...(spec.projectId !== undefined ? { projectId: spec.projectId } : {}),
      agent,
      status: "running",
      startedAt,
      artifacts: ["prompt.md", "summary.md", "log.txt"],
      modelPoolId: modelPool
    });

    const runDir = path.join(root, "data", "runs", run.id);
    await ensureDir(runDir);
    const logPath = path.join(runDir, "log.txt");
    await writeFile(path.join(runDir, "prompt.md"), prompt, "utf8");
    await writeFile(logPath, "", "utf8");

    const stubTask: HarnessTask = {
      id: spec.taskId,
      title: spec.taskTitle,
      description: prompt,
      agent,
      source: "autonomy",
      links: [],
      targets: [],
      messages: [],
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
      turnCount: turnNumber,
      ...(spec.projectId !== undefined ? { projectId: spec.projectId } : {}),
      ...(spec.repoPath !== undefined ? { repoPath: spec.repoPath } : {})
    };

    const launch = await resolveLaunchByIds(root, agent, modelPool);
    const runner = options?.runner ?? createAgentRunner(agent, launch ?? undefined);
    const canResume =
      state.sessionAgent === agent &&
      (state.sessionModelPool ?? undefined) === modelPool &&
      Boolean(state.sessionId);
    registerInflightTurn(spec.taskId, runner, run.id);
    let result;
    try {
      result = await runner.runTurn({
      mode: "plan",
      task: stubTask,
      prompt,
      cwd: root,
      turnNumber,
      ...(canResume && state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
      harnessRoot: root,
      runId: run.id,
      runDir,
      onOutput: (chunk) => {
        void appendFile(logPath, chunk).catch(() => {});
      }
    });
    } finally {
      clearInflightTurn(spec.taskId, run.id);
    }

    const completedAt = now();
    const reply = result.reply.trim() || result.blockedReason || "(no reply)";
    await writeFile(path.join(runDir, "summary.md"), `${reply}\n`, "utf8");

    const status = result.exitCode === 0 && !result.blockedReason ? "completed" : "blocked";
    if (status === "blocked") {
      await markPoolExhaustedFromFailure(root, agent, modelPool, result.blockedReason);
    }
    await updateRun(root, run.id, {
      status,
      completedAt,
      command: result.command,
      exitCode: result.exitCode,
      ...(result.blockedReason !== undefined ? { blockedReason: result.blockedReason } : {}),
      artifacts: ["prompt.md", "summary.md", "log.txt"]
    });

    const sessionId =
      result.exitCode === 0
        ? (result.sessionId ?? (canResume ? state.sessionId : undefined))
        : undefined;
    await writeState(root, spec.stateFileName, {
      lastRunAt: completedAt,
      ...(sessionId !== undefined ? { sessionId } : {}),
      sessionAgent: agent,
      sessionModelPool: modelPool,
      turnCount: turnNumber
    });

    if (spec.afterTurn) {
      await spec.afterTurn(root);
    }

    const proposalsAfter = (await listProposalTasks(root)).length;
    const proposalsCreated = Math.max(0, proposalsAfter - proposalsBefore);

    return {
      runId: run.id,
      status,
      proposalsCreated,
      summary:
        status === "completed"
          ? spec.completedSummary(turnNumber, proposalsCreated)
          : spec.blockedSummary(result.blockedReason ?? `exit ${result.exitCode}`)
    };
  } finally {
    await releaseLock(root, spec.stateFileName);
  }
}
