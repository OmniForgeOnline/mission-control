export type StateScope =
  | "chrome"
  | "tasks"
  | "intake"
  | "runs"
  | "memory"
  | "connectors"
  | "settings"
  | "autonomy"
  | "all"
  | `task:${string}`
  | `task:${string}:activity`
  | `task:${string}:messages`;

type StateChangeListener = (scopes: StateScope[]) => void;

const listeners = new Set<StateChangeListener>();

export function onStateChange(listener: StateChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitStateChange(scopes: StateScope[]): void {
  if (!scopes.length) return;
  for (const listener of listeners) {
    try {
      listener(scopes);
    } catch {
      /* listener errors must not break writers */
    }
  }
}

export function taskScopes(taskId: string): StateScope[] {
  return ["chrome", "tasks", `task:${taskId}`];
}

export function taskActivityScope(taskId: string): StateScope {
  return `task:${taskId}:activity`;
}

export function taskMessagesScope(taskId: string): StateScope {
  return `task:${taskId}:messages`;
}