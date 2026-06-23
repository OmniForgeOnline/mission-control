import { loadAgentConfig } from "./store.ts";
import { clearExpiredRuntimeExhaustion, saveUsageSnapshots } from "./usage-store.ts";
import { type UsageSnapshot, type UsageSnapshots } from "./usage.ts";
import {
  defaultUsageProviderDeps,
  fetchPoolUsage,
  type UsageProviderDeps
} from "./usage-providers.ts";

/**
 * Refresh usage by querying each model pool's live provider (codex app-server,
 * Claude oauth/usage). Pools with `usageSource: "none"` report nothing and
 * render as unavailable — no fabricated data.
 *
 * Pools that share a provider account are fetched once and reused (e.g. all
 * codex pools share the codex subscription window).
 */
export async function refreshUsageSnapshots(
  root: string,
  deps: UsageProviderDeps = defaultUsageProviderDeps
): Promise<UsageSnapshots> {
  const bundle = await loadAgentConfig(root);
  const toolsById = new Map(bundle.tools.map((tool) => [tool.id, tool]));
  const snapshots: UsageSnapshot[] = [];
  const cacheByKey = new Map<string, UsageSnapshot | null>();

  for (const pool of bundle.pools) {
    if (pool.usageSource === "none") continue;
    const tool = toolsById.get(pool.toolId);
    if (!tool || !tool.enabled || !pool.enabled) continue;

    // Account-level sources (codex) are shared across a tool's pools; cache by source+tool.
    const cacheKey = `${pool.usageSource}:${tool.id}`;
    let result = cacheByKey.get(cacheKey);
    if (result === undefined) {
      result = await fetchPoolUsage(tool, pool, root, deps);
      cacheByKey.set(cacheKey, result);
    } else if (result) {
      // Re-key the cached reading to this pool.
      result = { ...result, modelPoolId: pool.id };
    }
    if (result) snapshots.push(result);
  }

  await clearExpiredRuntimeExhaustion(root);
  const usage: UsageSnapshots = { snapshots, refreshedAt: new Date().toISOString() };
  await saveUsageSnapshots(root, usage);
  return usage;
}
