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

export function includesScope(scopes: StateScope[], target: StateScope): boolean {
  return scopes.includes("all") || scopes.includes(target);
}

export function includesTaskScope(scopes: StateScope[], taskId: string | null): boolean {
  if (!taskId) return false;
  return (
    includesScope(scopes, "tasks") ||
    includesScope(scopes, `task:${taskId}`) ||
    includesScope(scopes, `task:${taskId}:messages`)
  );
}

export function includesTaskActivityScope(scopes: StateScope[], taskId: string | null): boolean {
  if (!taskId) return false;
  return includesScope(scopes, `task:${taskId}:activity`);
}

export function unionScopes(existing: StateScope[], incoming: StateScope[]): StateScope[] {
  const set = new Set<StateScope>([...existing, ...incoming]);
  if (set.has("all")) return ["all"];
  return [...set];
}