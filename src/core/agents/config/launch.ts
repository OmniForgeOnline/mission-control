import type { ToolId } from "../../types.ts";
import { loadAgentConfig } from "./store.ts";
import { loadUsageSnapshots } from "./usage-store.ts";
import { bestPoolForTool } from "./optimizer.ts";
import type { AgentToolConfig, ModelPoolConfig } from "./types.ts";

export interface ResolvedLaunch {
  tool: AgentToolConfig;
  pool: ModelPoolConfig;
}

/**
 * Resolve the concrete tool + model pool to launch for an explicitly chosen
 * tool id and workflow role. Returns null when the tool is unknown or has no
 * eligible (enabled, non-exhausted) model pool.
 */
export async function resolveRunnerLaunch(
  root: string,
  toolId: ToolId,
  role: string
): Promise<ResolvedLaunch | null> {
  const [bundle, usage] = await Promise.all([loadAgentConfig(root), loadUsageSnapshots(root)]);
  const tool = bundle.tools.find((entry) => entry.id === toolId);
  if (!tool) return null;
  // Default: the tool's no-arg pool, so the tool runs with whatever model it is
  // configured against (don't force a specific model by default). The optimizer
  // is only a fallback when no no-arg pool exists.
  const defaultPool = bundle.pools.find(
    (pool) => pool.toolId === toolId && pool.enabled && pool.modelArgs.length === 0
  );
  if (defaultPool) return { tool, pool: defaultPool };
  const pool = bestPoolForTool(bundle, usage, toolId, role);
  if (!pool) return null;
  return { tool, pool };
}

/** Resolve a launch by explicit tool + model pool ids (exact, no re-selection). */
export async function resolveLaunchByIds(
  root: string,
  toolId: ToolId,
  modelPoolId: string
): Promise<ResolvedLaunch | null> {
  const bundle = await loadAgentConfig(root);
  const tool = bundle.tools.find((entry) => entry.id === toolId);
  const pool = bundle.pools.find((entry) => entry.id === modelPoolId);
  if (!tool || !pool) return null;
  return { tool, pool };
}
