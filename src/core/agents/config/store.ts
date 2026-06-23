import path from "node:path";

import { readJsonFile, updateJsonFile, writeJsonFile } from "../../infra/fs.ts";
import { ensureHarnessRepository } from "../../bootstrap/repository.ts";
import { normalizeBundle } from "./normalize.ts";
import { builtinAgentConfigBundle } from "./templates.ts";
import type {
  AgentConfigBundle,
  AgentToolConfig,
  ModelPoolConfig,
  RoutingProfileConfig,
  ToolId
} from "./types.ts";

function configPath(root: string): string {
  return path.join(root, "data", "state", "agent-config.json");
}

/**
 * Load the agent config bundle. On first run (no file), seed the built-in
 * templates merged with any legacy agent-policies.json limits, then persist.
 * On subsequent runs, merge any newly-added built-in tools/pools that are
 * missing from the stored config.
 */
export async function loadAgentConfig(root: string): Promise<AgentConfigBundle> {
  await ensureHarnessRepository(root);
  const stored = await readJsonFile<Partial<AgentConfigBundle> | null>(configPath(root), null);
  if (!stored || !Array.isArray(stored.tools) || stored.tools.length === 0) {
    const seeded = normalizeBundle(builtinAgentConfigBundle());
    await writeJsonFile(configPath(root), seeded);
    return seeded;
  }
  const bundle = normalizeBundle(stored);
  const merged = mergeBuiltins(bundle);
  if (merged !== bundle) {
    await writeJsonFile(configPath(root), merged);
  }
  return merged;
}

function mergeBuiltins(current: AgentConfigBundle): AgentConfigBundle {
  const builtins = builtinAgentConfigBundle();
  let changed = false;

  const tools = [...current.tools];
  const toolById = new Map(tools.map((tool, index) => [tool.id, { tool, index }]));
  for (const builtin of builtins.tools) {
    const existing = toolById.get(builtin.id);
    if (!existing) {
      tools.push({ ...builtin });
      changed = true;
    } else if (existing.tool.builtin) {
      const next = { ...existing.tool, usage: builtin.usage };
      if (JSON.stringify(next.usage) !== JSON.stringify(existing.tool.usage)) {
        tools[existing.index] = next;
        changed = true;
      }
    }
  }

  const pools = [...current.pools];
  const poolById = new Map(pools.map((pool, index) => [pool.id, { pool, index }]));
  for (const builtin of builtins.pools) {
    const existing = poolById.get(builtin.id);
    if (!existing) {
      pools.push({ ...builtin });
      changed = true;
    } else if (existing.pool.builtin) {
      const next = { ...existing.pool, usage: builtin.usage, usageSource: builtin.usageSource };
      if (
        JSON.stringify(next.usage) !== JSON.stringify(existing.pool.usage) ||
        next.usageSource !== existing.pool.usageSource
      ) {
        pools[existing.index] = next;
        changed = true;
      }
    }
  }

  if (!changed) return current;
  return normalizeBundle({ ...current, tools, pools });
}

async function mutate(
  root: string,
  mutator: (bundle: AgentConfigBundle) => AgentConfigBundle
): Promise<AgentConfigBundle> {
  await ensureHarnessRepository(root);
  // Ensure the file exists (seeds on first run) so updateJsonFile has a baseline.
  await loadAgentConfig(root);
  return updateJsonFile<AgentConfigBundle>(
    configPath(root),
    builtinAgentConfigBundle(),
    (current) => normalizeBundle(mutator(normalizeBundle(current)))
  );
}

export async function saveAgentConfig(root: string, bundle: AgentConfigBundle): Promise<AgentConfigBundle> {
  const normalized = normalizeBundle(bundle);
  await ensureHarnessRepository(root);
  await writeJsonFile(configPath(root), normalized);
  return normalized;
}

export async function upsertTool(root: string, tool: AgentToolConfig): Promise<AgentConfigBundle> {
  return mutate(root, (bundle) => ({
    ...bundle,
    tools: replaceById(bundle.tools, tool, (entry) => entry.id)
  }));
}

export async function removeTool(root: string, toolId: ToolId): Promise<AgentConfigBundle> {
  return mutate(root, (bundle) => {
    const tool = bundle.tools.find((entry) => entry.id === toolId);
    if (tool?.builtin) throw new Error(`Cannot delete built-in tool "${toolId}".`);
    return {
      ...bundle,
      tools: bundle.tools.filter((entry) => entry.id !== toolId),
      pools: bundle.pools.filter((entry) => entry.toolId !== toolId)
    };
  });
}

export async function upsertModelPool(root: string, pool: ModelPoolConfig): Promise<AgentConfigBundle> {
  return mutate(root, (bundle) => ({
    ...bundle,
    pools: replaceById(bundle.pools, pool, (entry) => entry.id)
  }));
}

export async function removeModelPool(root: string, poolId: string): Promise<AgentConfigBundle> {
  return mutate(root, (bundle) => {
    const pool = bundle.pools.find((entry) => entry.id === poolId);
    if (pool?.builtin) throw new Error(`Cannot delete built-in model pool "${poolId}".`);
    return { ...bundle, pools: bundle.pools.filter((entry) => entry.id !== poolId) };
  });
}

export async function upsertRoutingProfile(
  root: string,
  profile: RoutingProfileConfig
): Promise<AgentConfigBundle> {
  return mutate(root, (bundle) => ({
    ...bundle,
    profiles: replaceById(bundle.profiles, profile, (entry) => entry.role)
  }));
}

function replaceById<T>(list: T[], next: T, key: (entry: T) => string): T[] {
  const id = key(next);
  const index = list.findIndex((entry) => key(entry) === id);
  if (index === -1) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}
