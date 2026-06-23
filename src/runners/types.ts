import type { ToolId, HarnessTask } from "../core/types.ts";
import type { RunEventInput } from "../core/runs/events.ts";

/** A single observed agent action during a turn, used for liveness + UI. */
export interface AgentActivity {
  /** Short label suitable for inline display, e.g. "editing styles.css". */
  label: string;
  /** ISO timestamp the activity was observed. */
  at: string;
}

export interface AgentTurnRequest {
  /** When "plan", the runner uses the agent's planning mode (read-only, no edits). */
  mode?: "execute" | "plan";
  task: HarnessTask;
  /** Prompt for this turn. For the first turn, this is the task prompt; for follow-ups, the operator's reply. */
  prompt: string;
  /** Working directory the agent should run in. */
  cwd: string;
  /** Stable per-task session id, when the agent CLI supports one. Empty on the first turn. */
  sessionId?: string;
  /** Cumulative turn number, 1-based. */
  turnNumber: number;
  /** Stream raw output bytes for live tailing / artifact append. */
  onOutput?: (chunk: string) => void;
  /**
   * Report a short, human-readable description of what the agent is doing right
   * now (e.g. "editing styles.css", "running tests"). Fired on every meaningful
   * agent event so the daemon can drive a real heartbeat and detect stalls.
   */
  onActivity?: (activity: AgentActivity) => void;
  /** Harness root, used to wire the gbrain MCP server. */
  harnessRoot?: string;
  /** Run id, used for per-run MCP config files and audit logs. */
  runId?: string;
  /** Run directory for storing MCP config files. */
  runDir?: string;
  /** Fires once when the session id is known mid-turn (for incremental persistence). */
  onSessionId?: (sessionId: string) => void;
  /** Stream canonical run events (text/thinking/tool/session) for live transcript + SSE. */
  onEvent?: (event: RunEventInput) => void;
  /** Run as a live bidirectional turn (persistent stdin) when the runner supports it. */
  live?: boolean;
}

export interface AgentTurnResult {
  /** Markdown reply that the agent posts back into the task thread. */
  reply: string;
  /** Session id we should remember on the task (claude/codex emit this). */
  sessionId?: string;
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Full command line used to launch the agent. */
  command: string;
  /** Reason the turn ended unsuccessfully. Set when exitCode !== 0. */
  blockedReason?: string;
  /** Concatenated stdout+stderr captured from the agent (for the run log). */
  rawLog: string;
}

export interface AgentRunner {
  agent: ToolId;
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult>;
  /** Abort the in-flight turn (if any). Idempotent. */
  abort(): void;
}

/**
 * A runner that can accept operator messages mid-turn (persistent stdin).
 * `supportsMidTurnInput` reflects the agent's capability; `sendOperatorMessage`
 * is a no-op when no live turn is currently accepting input.
 */
export interface LiveAgentRunner extends AgentRunner {
  readonly supportsMidTurnInput: boolean;
  /** Deliver an operator message into the live turn. Returns true if accepted. */
  sendOperatorMessage(text: string): boolean;
}

export function isLiveRunner(runner: AgentRunner): runner is LiveAgentRunner {
  const candidate = runner as Partial<LiveAgentRunner>;
  return typeof candidate.sendOperatorMessage === "function" && candidate.supportsMidTurnInput === true;
}
