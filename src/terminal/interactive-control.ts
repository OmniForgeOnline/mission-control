export type InteractiveOutcomeKind = "done" | "blocked" | "aborted";

export interface InteractiveOutcome {
  kind: InteractiveOutcomeKind;
  note?: string;
}

export interface InteractiveWaitMeta {
  terminalSessionId?: string;
  runId?: string;
}

interface Waiter extends InteractiveWaitMeta {
  resolve: (outcome: InteractiveOutcome) => void;
}

const waiters = new Map<string, Waiter>();

/**
 * Register a long-lived interactive turn wait for a task. Resolves when the
 * operator marks Done/Block or the runner aborts. Replaces any prior waiter
 * for the same task (superseded sessions resolve as aborted).
 */
export function beginInteractiveWait(
  taskId: string,
  meta: InteractiveWaitMeta = {}
): Promise<InteractiveOutcome> {
  const existing = waiters.get(taskId);
  if (existing) {
    existing.resolve({
      kind: "aborted",
      note: "Superseded by a new interactive session"
    });
    waiters.delete(taskId);
  }

  return new Promise<InteractiveOutcome>((resolve) => {
    waiters.set(taskId, {
      resolve,
      ...(meta.terminalSessionId !== undefined ? { terminalSessionId: meta.terminalSessionId } : {}),
      ...(meta.runId !== undefined ? { runId: meta.runId } : {})
    });
  });
}

/** Update session metadata after the PTY is created (waiter already registered). */
export function bindInteractiveSession(
  taskId: string,
  meta: InteractiveWaitMeta
): void {
  const waiter = waiters.get(taskId);
  if (!waiter) return;
  if (meta.terminalSessionId !== undefined) waiter.terminalSessionId = meta.terminalSessionId;
  if (meta.runId !== undefined) waiter.runId = meta.runId;
}

export function completeInteractiveTurn(taskId: string, outcome: InteractiveOutcome): boolean {
  const waiter = waiters.get(taskId);
  if (!waiter) return false;
  waiters.delete(taskId);
  waiter.resolve(outcome);
  return true;
}

export function getInteractiveWait(taskId: string): InteractiveWaitMeta | undefined {
  const waiter = waiters.get(taskId);
  if (!waiter) return undefined;
  return {
    ...(waiter.terminalSessionId !== undefined ? { terminalSessionId: waiter.terminalSessionId } : {}),
    ...(waiter.runId !== undefined ? { runId: waiter.runId } : {})
  };
}

export function listInteractiveWaits(): Array<{ taskId: string } & InteractiveWaitMeta> {
  return [...waiters.entries()].map(([taskId, waiter]) => ({
    taskId,
    ...(waiter.terminalSessionId !== undefined ? { terminalSessionId: waiter.terminalSessionId } : {}),
    ...(waiter.runId !== undefined ? { runId: waiter.runId } : {})
  }));
}

export function resetInteractiveControlForTests(): void {
  for (const [taskId, waiter] of waiters) {
    waiter.resolve({ kind: "aborted", note: "test reset" });
    waiters.delete(taskId);
  }
}
