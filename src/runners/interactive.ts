import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { ToolId } from "../core/types.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../core/agents/config/types.ts";
import { buildInteractiveLaunch } from "../terminal/interactive-launch.ts";
import { buildPtyEnvironment } from "../terminal/env.ts";
import { isAuthorHandoffReady } from "../terminal/handoff-ready.ts";
import { getTerminalSessionManager } from "../terminal/manager.ts";
import {
  beginInteractiveWait,
  bindInteractiveSession,
  completeInteractiveTurn
} from "../terminal/interactive-control.ts";
import { emitStateChange, taskScopes } from "../core/infra/state-bus.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "./types.ts";
import type { RunnerLaunchContext } from "./headless.ts";

const HANDOFF_POLL_MS = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs an agent CLI in a real PTY (interactive TUI). The harness starts the
 * same prompt/mode/model session the headless runner would — as one PTY the UI
 * attaches to.
 *
 * Planning (`mode: plan`) waits for operator Done/Block so the human can answer
 * questions. Authoring/implement turns also auto-complete when the agent process
 * exits or the git handoff contract is met (commit + push), so the workflow can
 * chain into automated steps without a mandatory Done click — while the operator
 * can still type into the TUI or press Block at any time.
 */
export class InteractiveAgentRunner implements AgentRunner {
  agent: ToolId;
  private tool: AgentToolConfig;
  private pool: ModelPoolConfig;
  private currentTaskId: string | null = null;
  private currentSessionId: string | null = null;
  private aborted = false;

  constructor(agent: ToolId, launch: RunnerLaunchContext) {
    this.agent = agent;
    this.tool = launch.tool;
    this.pool = launch.pool;
  }

  abort(): void {
    this.aborted = true;
    const taskId = this.currentTaskId;
    if (taskId) {
      completeInteractiveTurn(taskId, {
        kind: "aborted",
        note: "Stopped by operator"
      });
    }
    if (this.currentSessionId) {
      try {
        getTerminalSessionManager().dispose(this.currentSessionId);
      } catch {
        /* ignore */
      }
      this.currentSessionId = null;
    }
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.aborted = false;
    this.currentTaskId = request.task.id;

    // Register the waiter first so abort during launch still resolves.
    const outcomePromise = beginInteractiveWait(request.task.id, {
      ...(request.runId !== undefined ? { runId: request.runId } : {})
    });

    const effort = request.task.effort;
    const promptFile = request.runDir ? path.join(request.runDir, "prompt.md") : undefined;
    const launch = buildInteractiveLaunch(this.tool, this.pool, request.cwd, {
      ...(effort !== undefined ? { effort } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      prompt: request.prompt,
      ...(promptFile !== undefined ? { promptFile } : {})
    });
    if (!launch) {
      completeInteractiveTurn(request.task.id, {
        kind: "aborted",
        note: `Tool "${this.tool.id}" has no interactive TUI mode.`
      });
      throw new Error(
        `Tool "${this.tool.id}" (adapter ${this.tool.adapter}) has no interactive TUI mode.`
      );
    }

    // MCP / extension flags (same path as headless) so interactive sessions see gbrain etc.
    let prefixArgs: string[] = [];
    let extraEnv: Record<string, string> = {};
    if (request.harnessRoot && request.runId && request.runDir) {
      try {
        const { writeLaunchExtensions } = await import("../mcp/launcher.ts");
        const projectId = request.task.projectId;
        const mcp = await writeLaunchExtensions({
          tool: this.tool,
          harnessRoot: request.harnessRoot,
          runId: request.runId,
          runDir: request.runDir,
          cwd: request.cwd,
          extensions: request.extensionEntries ?? [],
          enabledExtensionIds: request.enabledExtensionIds ?? [],
          ...(projectId ? { projectId } : {})
        });
        prefixArgs = mcp.cliArgs;
        extraEnv = mcp.env;
      } catch {
        /* MCP optional for interactive; agent still runs without it */
      }
    }

    const spawnArgs = [...prefixArgs, ...launch.args];
    const manager = getTerminalSessionManager();
    // Drop any prior live session for this task so reattach targets this turn.
    const prior = manager.findByTaskId(request.task.id);
    if (prior?.alive) {
      manager.dispose(prior.id);
    }

    let session;
    try {
      const env = buildPtyEnvironment({ ...launch.env, ...extraEnv });
      session = manager.create({
        command: launch.command,
        args: spawnArgs,
        cwd: request.cwd,
        env,
        cols: 120,
        rows: 36,
        taskId: request.task.id,
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
        label: this.tool.id
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      completeInteractiveTurn(request.task.id, { kind: "aborted", note: message });
      throw err;
    }
    this.currentSessionId = session.id;
    bindInteractiveSession(request.task.id, {
      terminalSessionId: session.id,
      ...(request.runId !== undefined ? { runId: request.runId } : {})
    });
    // Push interactiveSessions into /api/state so the UI auto-attaches.
    emitStateChange(taskScopes(request.task.id));

    // Planning stays operator-driven (Done). Authoring auto-advances when the
    // process exits or the git handoff contract is met so automated steps chain.
    const planningTurn = request.mode === "plan" || request.mode === "classify";
    const unsubExit = manager.subscribe(session.id, (msg) => {
      if (msg.type !== "exit") return;
      if (planningTurn) return;
      if (this.aborted) return;
      const code = msg.code ?? 1;
      completeInteractiveTurn(request.task.id, {
        kind: code === 0 ? "done" : "aborted",
        note:
          code === 0
            ? "Agent process exited; advancing workflow."
            : `Agent process exited with code ${code}.`
      });
    });

    let handoffPoll: ReturnType<typeof setInterval> | undefined;
    if (!planningTurn) {
      handoffPoll = setInterval(() => {
        if (this.aborted) return;
        void isAuthorHandoffReady(request.cwd).then((ready) => {
          if (!ready || this.aborted) return;
          completeInteractiveTurn(request.task.id, {
            kind: "done",
            note: "Author handoff detected (committed and pushed); advancing workflow."
          });
        });
      }, HANDOFF_POLL_MS);
      handoffPoll.unref?.();
    }

    const fullCommand = [launch.command, ...spawnArgs].join(" ");
    const modelNote = this.pool.modelArgs.length
      ? ` modelArgs=${JSON.stringify(this.pool.modelArgs)}`
      : " modelArgs=[]";
    const effortNote = effort ? ` effort=${effort}` : "";
    const modeNote = request.mode ? ` mode=${request.mode}` : "";
    request.onOutput?.(
      `[${this.agent}] interactive PTY (single session — prompt on argv, not headless -p/exec)\n` +
        `[${this.agent}] PTY session ${session.id}\n` +
        `[${this.agent}] command: ${fullCommand}\n` +
        `[${this.agent}] pool=${this.pool.id}${modelNote}${effortNote}${modeNote}\n` +
        `[${this.agent}] cwd: ${request.cwd}\n` +
        (planningTurn
          ? `[${this.agent}] planning: interact in the UI terminal; Done advances when you are ready\n`
          : `[${this.agent}] authoring: interact anytime; Done/Block still work; auto-advances on exit or successful push\n`)
    );
    request.onActivity?.({ label: "interactive terminal open", at: nowIso() });
    request.onEvent?.({
      type: "agent_status",
      text: `Interactive session ${session.id} ready`
    });

    if (request.runDir) {
      try {
        await appendFile(
          path.join(request.runDir, "pty-session.txt"),
          `sessionId=${session.id}\ncommand=${fullCommand}\ncwd=${request.cwd}\n`,
          "utf8"
        );
      } catch {
        /* non-fatal */
      }
    }

    let outcome;
    try {
      outcome = await outcomePromise;
    } finally {
      unsubExit();
      if (handoffPoll) clearInterval(handoffPoll);
    }

    if (this.currentSessionId) {
      try {
        manager.dispose(this.currentSessionId);
      } catch {
        /* ignore */
      }
      this.currentSessionId = null;
    }
    this.currentTaskId = null;

    const note = (outcome.note ?? "").trim();
    if (outcome.kind === "aborted" || this.aborted) {
      return {
        reply: note,
        exitCode: 1,
        command: fullCommand,
        blockedReason: note || "Stopped by operator",
        rawLog: "",
        interactive: true,
        operatorOutcome: "aborted"
      };
    }
    if (outcome.kind === "blocked") {
      return {
        reply: note,
        exitCode: 1,
        command: fullCommand,
        blockedReason: note || "Blocked by operator",
        rawLog: "",
        interactive: true,
        operatorOutcome: "blocked"
      };
    }
    return {
      // Avoid "completed"/"done" markers that trip looksLikeFinalAnswer falsely.
      reply: note || "Operator finished the interactive step.",
      exitCode: 0,
      command: fullCommand,
      rawLog: "",
      interactive: true,
      operatorOutcome: "done"
    };
  }
}
