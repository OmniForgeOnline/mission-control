import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { extractSessionIdFromStreamEvent, parseAgentOutput } from "../core/agents/output.ts";
import { writeLaunchExtensions } from "../mcp/launcher.ts";
import type { ToolId, EffortLevel } from "../core/types.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../core/agents/config/types.ts";
import { buildLaunchArgs } from "./adapter.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "./types.ts";
import { describeAgentEvent } from "./activity-map.ts";
import { runEventsFromStreamEvent } from "../core/runs/normalize-events.ts";
import type { RunEventInput } from "../core/runs/events.ts";
import { probeAgentRuntime } from "../core/agents/runtime/probe.ts";
import { resolveAgentLaunchPlan } from "../core/agents/runtime/launch.ts";
import {
  checkPromptBudget,
  deliverPrompt,
  promptTransportForLaunch,
  streamJsonUserMessage
} from "../core/agents/runtime/prompt-transport.ts";

export { streamJsonUserMessage } from "../core/agents/runtime/prompt-transport.ts";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Format the spawn notice for an agent turn. The label (when set by the caller,
 * e.g. "quality-gate", "quickstarts") disambiguates concurrent turns whose
 * command lines are otherwise identical — the prompt travels over stdin, so two
 * different features spawn the agent with the same argv. The turn number
 * surfaces retries within one generation.
 */
export function formatSpawnNotice(
  agent: string,
  turnNumber: number,
  label: string | undefined,
  fullCommand: string
): string {
  const tag = label ? `(${label}, turn ${turnNumber})` : `(turn ${turnNumber})`;
  return `[${agent}] spawning ${tag}: ${fullCommand}`;
}

/** Explicit tool + model pool the runner should launch. */
export interface RunnerLaunchContext {
  tool: AgentToolConfig;
  pool: ModelPoolConfig;
}

/**
 * Headless agent runner. We never attach a TTY: the agent runs as a regular
 * child process with stdin/stdout/stderr piped, then exits when its turn is done.
 *
 * The runner is fully driven by the agent config (tool + model pool); there is
 * no implicit fallback to a bundled definition.
 */
export class HeadlessAgentRunner implements AgentRunner {
  agent: ToolId;
  private tool: AgentToolConfig;
  private pool: ModelPoolConfig;
  private current: ChildProcessWithoutNullStreams | null = null;
  private aborted = false;
  /** True when this runner's agent can accept operator messages mid-turn. */
  private readonly live: boolean;
  /** True while a live turn's stdin is open and accepting messages. */
  private liveStdinOpen = false;
  /** onEvent sink for the active turn, used to surface operator messages. */
  private currentOnEvent: ((event: RunEventInput) => void) | undefined = undefined;

  constructor(agent: ToolId, launch: RunnerLaunchContext) {
    this.agent = agent;
    this.tool = launch.tool;
    this.pool = launch.pool;
    this.live = Boolean(launch.tool.cli.midTurnInput);
  }

  /** Capability hint for runner selection / routing (see LiveAgentRunner). */
  get supportsMidTurnInput(): boolean {
    return this.live;
  }

  /**
   * Deliver an operator message into a live turn's stdin. No-op unless a live
   * (stream-json input) turn is currently running with an open stdin.
   */
  sendOperatorMessage(text: string): boolean {
    const child = this.current;
    if (!child || !this.liveStdinOpen || !child.stdin.writable) return false;
    try {
      child.stdin.write(streamJsonUserMessage(text), "utf8");
      this.currentOnEvent?.({ type: "operator_message", text });
      return true;
    } catch {
      // Process may have exited between the check and the write.
      return false;
    }
  }

  abort(): void {
    this.aborted = true;
    const child = this.current;
    if (!child) return;
    try {
      child.kill("SIGTERM");
      // Hard cap: if it doesn't go away in 2s, SIGKILL.
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 2000).unref();
    } catch {
      /* ignore */
    }
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.aborted = false;
    const probe = await probeAgentRuntime(this.tool, { cwd: request.cwd });
    const launch = this.buildLaunch(request, probe.capabilities);
    const promptBudgetError = checkPromptBudget(this.tool, request.prompt);
    if (promptBudgetError) {
      return {
        reply: "",
        exitCode: 1,
        command: this.tool.command,
        blockedReason: promptBudgetError.message,
        rawLog: promptBudgetError.message
      };
    }
    const baseArgs = launch.args;

    let extraEnv: Record<string, string> = {};
    let prefixArgs: string[] = [];
    const needsMcp = Boolean(request.harnessRoot && request.runId && request.runDir);
    if (needsMcp) {
      const projectId = request.task.projectId;
      const mcp = await writeLaunchExtensions({
        tool: this.tool,
        harnessRoot: request.harnessRoot!,
        runId: request.runId!,
        runDir: request.runDir!,
        cwd: request.cwd,
        extensions: request.extensionEntries ?? [],
        enabledExtensionIds: request.enabledExtensionIds ?? [],
        ...(projectId ? { projectId } : {})
      });
      extraEnv = mcp.env;
      prefixArgs = mcp.cliArgs;
    }
    const args = [...prefixArgs, ...baseArgs];
    const plan = await resolveAgentLaunchPlan(this.tool, this.pool, {
      cwd: request.cwd,
      args,
      env: { ...launch.env, ...extraEnv }
    });
    const fullCommand = [plan.command, ...args].join(" ");
    if (!plan.available) {
      const reason = plan.diagnostics[0]?.message ?? `Failed to resolve ${this.agent}`;
      return { reply: "", exitCode: 1, command: fullCommand, blockedReason: reason, rawLog: reason };
    }

    return new Promise<AgentTurnResult>((resolve) => {
      const child = spawn(plan.command, args, {
        cwd: request.cwd,
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.current = child;
      const live = launch.inputStreamJson === true;
      const promptPlan = promptTransportForLaunch(this.tool, launch);
      this.currentOnEvent = request.onEvent;
      const endLiveStdin = (): void => {
        if (this.liveStdinOpen && child.stdin.writable) {
          try { child.stdin.end(); } catch { /* ignore */ }
        }
        this.liveStdinOpen = false;
      };
      console.log(formatSpawnNotice(this.agent, request.turnNumber, request.label, fullCommand));

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";

      const emitActivity = (label: string): void => {
        request.onActivity?.({ label, at: nowIso() });
      };
      // Process newline-delimited JSON events as they stream in so we can drive
      // a real heartbeat. Holds the trailing partial line until its newline.
      const consume = (chunk: string): void => {
        lineBuffer += chunk;
        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = lineBuffer.slice(0, newlineIndex).trim();
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          if (line) {
            // In live mode, the terminal result ends the turn: close stdin so
            // the process can exit (resolve happens on "close").
            if (live) {
              const evt = tryJson(line);
              if (isTerminalResultEvent(evt)) endLiveStdin();
            }
            processAgentStreamLine(line, this.agent, {
              ...(request.onSessionId !== undefined ? { onSessionId: request.onSessionId } : {}),
              ...(request.onEvent !== undefined ? { onEvent: request.onEvent } : {}),
              onActivity: emitActivity
            });
          }
          newlineIndex = lineBuffer.indexOf("\n");
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        request.onOutput?.(chunk);
        consume(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        request.onOutput?.(chunk);
        process.stderr.write(chunk);
      });

      child.on("error", (err) => {
        this.current = null;
        resolve({
          reply: "",
          exitCode: 1,
          command: [plan.command, ...args].join(" "),
          blockedReason: `Failed to start ${this.agent}: ${err.message}`,
          rawLog: `${stdout}\n${stderr}`
        });
      });

      child.on("close", (exitCode) => {
        this.current = null;
        this.liveStdinOpen = false;
        this.currentOnEvent = undefined;
        const code = typeof exitCode === "number" ? exitCode : 1;
        const parsed = this.parseOutput(stdout, stderr);
        const blockedReason = this.aborted
          ? "Stopped by operator"
          : code === 0
          ? undefined
          : parsed.errorReason ?? `${this.agent} exited with code ${code}`;

        if (code !== 0) {
          console.error(`[${this.agent}] exited ${code}: ${blockedReason}`);
        } else {
          console.log(`[${this.agent}] exited 0 (${(stdout.length / 1024).toFixed(1)} KB output)`);
        }

        const sessionId = parsed.sessionId ?? request.sessionId;
        resolve({
          reply: parsed.reply,
          ...(sessionId !== undefined ? { sessionId } : {}),
          exitCode: code,
          command: [plan.command, ...args].join(" "),
          ...(blockedReason !== undefined ? { blockedReason } : {}),
          rawLog: stdout + (stderr ? `\n[stderr]\n${stderr}` : "")
        });
      });

      if (live) {
        // Persistent stdin: send the initial prompt as a stream-json user
        // message and keep stdin open for mid-turn operator messages. Closed
        // on the terminal result event (endLiveStdin) or abort.
        this.liveStdinOpen = true;
        try { deliverPrompt(child.stdin, { ...promptPlan, keepOpen: true }, request.prompt); } catch { /* close/error handles */ }
      } else {
        try { deliverPrompt(child.stdin, promptPlan, request.prompt); } catch { /* close/error handles */ }
      }
    });
  }

  private buildLaunch(request: AgentTurnRequest, runtimeCapabilities: Record<string, boolean> = {}) {
    const effort = this.tool.supportsEffort
      ? (request.task.effort as EffortLevel | undefined)
      : undefined;
    const allowedDirs: string[] = [];
    for (const target of request.task.targets ?? []) {
      const dir = target.kind === "directory" ? target.path : path.dirname(target.path);
      if (dir) allowedDirs.push(dir);
    }
    return buildLaunchArgs(this.tool, this.pool, {
      mode: request.mode === "plan" ? "plan" : request.mode === "classify" ? "classify" : "execute",
      prompt: request.prompt,
      cwd: request.cwd,
      allowedDirs,
      ...(effort ? { effort } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.live ? { live: true } : {})
    }, runtimeCapabilities);
  }

  /**
   * Best-effort parser for both agents' streamed JSON output.
   *   - claude --output-format stream-json: NDJSON events. The final reply is on
   *     the terminal `{type:"result", result:"..."}` event; session id appears on
   *     every event as `session_id`. We fall back to the last assistant message.
   *   - codex exec --json: NDJSON of events; the assistant's final reply is the
   *     last `agent_message` event, and the session id appears in
   *     `session_configured` / `session.created` style events.
   *
   * If parsing fails, fall back to raw stdout so the operator at least sees
   * what came back.
   */
  private parseOutput(stdout: string, stderr: string): { reply: string; sessionId?: string; errorReason?: string } {
    const parsed = parseAgentOutput(stdout, this.agent);
    const hasStructuredReply = parsed.reply !== stdout.trim();
    // A structured error event from the agent (codex turn.failed / grok
    // type:error) is the authoritative failure reason; fall back to trailing
    // stderr only when the agent printed nothing structured.
    const stderrReason =
      !hasStructuredReply && stderr ? stderr.split(/\r?\n/).slice(-3).join(" ").trim() : undefined;
    const errorReason = parsed.errorReason ?? stderrReason;
    return {
      reply: parsed.reply,
      ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      ...(errorReason !== undefined ? { errorReason } : {})
    };
  }
}

function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Whether a streamed event marks the end of the agent's turn. */
function isTerminalResultEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = (event as Record<string, unknown>)["type"];
  return type === "result" || type === "final";
}

/** Handle one NDJSON line from an agent CLI stdout stream. */
export function processAgentStreamLine(
  line: string,
  agent: ToolId,
  handlers: {
    onSessionId?: (sessionId: string) => void;
    onActivity?: (label: string) => void;
    onEvent?: (event: RunEventInput) => void;
  }
): void {
  const event = tryJson(line.trim());
  if (!event || typeof event !== "object") return;
  const sessionId = extractSessionIdFromStreamEvent(event);
  if (sessionId) handlers.onSessionId?.(sessionId);
  const label = describeAgentEvent(agent, event);
  if (label) handlers.onActivity?.(label);
  if (handlers.onEvent) {
    for (const runEvent of runEventsFromStreamEvent(agent, event)) {
      handlers.onEvent(runEvent);
    }
  }
}
