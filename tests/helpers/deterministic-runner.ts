import type { ToolId } from "../../src/core/types.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../../src/runners/types.ts";

/**
 * Deterministic, network-free runner for tests.
 * Returns a canned reply that includes request details so tests can assert the
 * prompt and workspace flowed through without launching a real agent CLI.
 */
export class DeterministicAgentRunner implements AgentRunner {
  agent: ToolId;
  private replies: string[] = [];
  private replyIndex = 0;

  constructor(agent: ToolId = "claude") {
    this.agent = agent;
  }

  setReplies(replies: string[]): void {
    this.replies = replies;
    this.replyIndex = 0;
  }

  abort(): void {
    /* no-op: deterministic test runs are synchronous */
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const reply =
      this.replies[this.replyIndex++] ??
      `Deterministic ${this.agent} reply for "${request.task.title}" (turn ${request.turnNumber}).`;
    const log = `${reply}\nPrompt length: ${request.prompt.length}\nCwd: ${request.cwd}\nTargets: ${request.task.targets
      .map((t) => t.path)
      .join(", ") || "none"}\n`;
    request.onActivity?.({ label: "writing a response", at: new Date().toISOString() });
    request.onOutput?.(log);
    return {
      reply,
      sessionId: request.sessionId ?? `test-${request.task.id}`,
      exitCode: 0,
      command: `deterministic ${this.agent} ${request.turnNumber}`,
      rawLog: log
    };
  }
}
