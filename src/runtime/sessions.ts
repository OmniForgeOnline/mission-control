import type { AgentRunner } from "../runners/types.ts";
import { isLiveRunner } from "../runners/types.ts";

/**
 * Tracks the agent runner for any task that currently has a turn in flight.
 * Keyed by taskId so it survives across runId changes (each turn gets a new run).
 */
const inflight = new Map<string, { runner: AgentRunner; runId?: string }>();

export function registerInflightTurn(taskId: string, runner: AgentRunner, runId?: string): void {
  inflight.set(taskId, { runner, ...(runId !== undefined ? { runId } : {}) });
}

export function clearInflightTurn(taskId: string, runId?: string): void {
  const current = inflight.get(taskId);
  if (runId !== undefined && current?.runId !== undefined && current.runId !== runId) {
    return;
  }
  inflight.delete(taskId);
}

export function abortInflightTurn(taskId: string): boolean {
  const current = inflight.get(taskId);
  if (!current) return false;
  current.runner.abort();
  inflight.delete(taskId);
  return true;
}

export function abortAllInflightTurns(): void {
  for (const current of inflight.values()) {
    current.runner.abort();
  }
  inflight.clear();
}

export function listInflightTaskIds(): string[] {
  return [...inflight.keys()];
}

/**
 * Route an operator message into a task's live turn, if one is active and the
 * runner accepts mid-turn input. Returns whether it was delivered (and the
 * active run id) so the caller can fall back to scheduling a follow-up turn.
 */
export function deliverOperatorMessageToLiveTurn(
  taskId: string,
  text: string
): { delivered: boolean; runId?: string } {
  const current = inflight.get(taskId);
  if (!current || !isLiveRunner(current.runner)) return { delivered: false };
  const delivered = current.runner.sendOperatorMessage(text);
  return { delivered, ...(current.runId !== undefined ? { runId: current.runId } : {}) };
}
