import { loadAgentConfig } from "../config/store.ts";
import { discoverExtensionsForTool, defaultDiscoverRoots } from "./discover.ts";
import { mergeRegistryWithDiscovery, resolveExtensionsForLaunch } from "./resolve.ts";
import { loadExtensionRegistry } from "./store.ts";
import type { ResolvedExtensionLaunch, ToolExtension, ExtensionRegistry } from "./types.ts";
import type { ToolId } from "../../types.ts";
import type { WorkflowStep } from "../../workflows/types.ts";

export interface ResolveStepExtensionsInput {
  root: string;
  toolId: ToolId;
  step?: WorkflowStep;
  cwd?: string;
}

/** Load registry, discover from disk, and resolve enabled extensions for a launch. */
export async function resolveStepExtensions(
  input: ResolveStepExtensionsInput
): Promise<ResolvedExtensionLaunch> {
  const [registry, bundle] = await Promise.all([
    loadExtensionRegistry(input.root),
    loadAgentConfig(input.root)
  ]);
  const tool = bundle.tools.find((entry) => entry.id === input.toolId);
  if (!tool) {
    return { enabledIds: [], entries: [] };
  }

  const roots = defaultDiscoverRoots(input.cwd);
  const discovery = await discoverExtensionsForTool(tool, roots);
  const entries = mergeRegistryWithDiscovery(
    registry.extensions.filter((entry) => entry.toolId === input.toolId),
    discovery.discovered
  );

  return resolveExtensionsForLaunch({
    toolId: input.toolId,
    registry: entries,
    discovered: discovery.discovered,
    ...(input.step?.extensions?.length ? { stepExtensionIds: input.step.extensions } : {})
  });
}

export async function loadMergedExtensions(
  root: string,
  toolId: ToolId,
  projectDir?: string
): Promise<ToolExtension[]> {
  const [registry, bundle] = await Promise.all([loadExtensionRegistry(root), loadAgentConfig(root)]);
  const tool = bundle.tools.find((entry) => entry.id === toolId);
  if (!tool) return registry.extensions.filter((entry) => entry.toolId === toolId);

  const discovery = await discoverExtensionsForTool(tool, defaultDiscoverRoots(projectDir));
  return mergeRegistryWithDiscovery(
    registry.extensions.filter((entry) => entry.toolId === toolId),
    discovery.discovered
  );
}

/** Live-merge disk discovery with persisted registry for all enabled tools. */
export async function loadAllMergedExtensions(
  root: string,
  opts?: { testMode?: boolean; projectDir?: string }
): Promise<ExtensionRegistry> {
  const registry = await loadExtensionRegistry(root);
  if (opts?.testMode) {
    return registry;
  }

  const bundle = await loadAgentConfig(root);
  const roots = defaultDiscoverRoots(opts?.projectDir);
  let merged = [...registry.extensions];

  for (const tool of bundle.tools.filter((entry) => entry.enabled)) {
    const discovery = await discoverExtensionsForTool(tool, roots);
    merged = [
      ...mergeRegistryWithDiscovery(
        merged.filter((entry) => entry.toolId === tool.id),
        discovery.discovered
      ),
      ...merged.filter((entry) => entry.toolId !== tool.id)
    ];
  }

  return {
    extensions: merged.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    lastDiscoveredAt: registry.lastDiscoveredAt ?? new Date().toISOString()
  };
}
