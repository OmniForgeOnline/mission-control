import { loadAgentConfig } from "./store.ts";
import { clearExpiredRuntimeExhaustion, loadUsageSnapshots, saveUsageSnapshots } from "./usage-store.ts";
import { type UsageSnapshot, type UsageSnapshots } from "./usage.ts";
import {
  defaultUsageProviderDeps,
  fetchPoolUsage,
  type UsageProviderDeps
} from "./usage-providers.ts";

/**
 * Refresh usage by querying each live provider (codex app-server, Claude
 * oauth/usage). Pools with `usageSource: "none"` contribute nothing — no
 * fabricated data.
 *
 * Live quotas are account-level (the tool's logged-in account), not per model.
 * Fetch once per (source, tool) and store a single tool-scoped snapshot.
 */
export async function refreshUsageSnapshots(
  root: string,
  deps: UsageProviderDeps = defaultUsageProviderDeps
): Promise<UsageSnapshots> {
  const bundle = await loadAgentConfig(root);
  const toolsById = new Map(bundle.tools.map((tool) => [tool.id, tool]));
  const snapshots: UsageSnapshot[] = [];
  const fetchedKeys = new Set<string>();

  for (const pool of bundle.pools) {
    if (pool.usageSource === "none") continue;
    const tool = toolsById.get(pool.toolId);
    if (!tool || !tool.enabled || !pool.enabled) continue;

    // Account-level sources are shared across a tool's models; fetch once.
    const cacheKey = `${pool.usageSource}:${tool.id}`;
    if (fetchedKeys.has(cacheKey)) continue;
    fetchedKeys.add(cacheKey);

    const result = await fetchPoolUsage(tool, pool, root, deps);
    if (result) snapshots.push(result);
  }

  await clearExpiredRuntimeExhaustion(root);
  // Keep per-pool runtime exhaustion markers (set when a turn hits rate limits).
  // Live provider reads are account/tool-scoped and must not wipe those.
  const previous = await loadUsageSnapshots(root);
  const runtimeSnaps = previous.snapshots.filter(
    (snap) => snap.modelPoolId && snap.windowLabel === "runtime-detected"
  );
  const usage: UsageSnapshots = {
    snapshots: [...snapshots, ...runtimeSnaps],
    refreshedAt: new Date().toISOString()
  };
  await saveUsageSnapshots(root, usage);
  return usage;
}
