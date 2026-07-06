import type { ToolId } from "../../types.ts";
import type { DiscoveredExtension, ResolvedExtensionLaunch, ToolExtension } from "./types.ts";

export interface ResolveExtensionsInput {
  toolId: ToolId;
  registry: ToolExtension[];
  discovered: DiscoveredExtension[];
  /** Step-level extension ids from workflow YAML. */
  stepExtensionIds?: string[];
}

/**
 * Merge discovery with registry and resolve the enabled set for a launch.
 *
 * Precedence:
 * 1. Step extensions facet (exact set, filtered to tool)
 * 2. Registry defaultEnabled entries
 * 3. Fallback: nothing (only gbrain MCP at launch)
 */
export function resolveExtensionsForLaunch(input: ResolveExtensionsInput): ResolvedExtensionLaunch {
  const toolEntries = input.registry.filter((entry) => entry.toolId === input.toolId);
  const toolDiscovered = input.discovered.filter((entry) => entry.toolId === input.toolId);

  let enabledIds: string[];
  if (input.stepExtensionIds?.length) {
    enabledIds = input.stepExtensionIds.filter((id) => {
      const inRegistry = toolEntries.some((entry) => entry.id === id);
      const inDiscovered = toolDiscovered.some((entry) => entry.id === id);
      return inRegistry || inDiscovered;
    });
  } else {
    enabledIds = toolEntries.filter((entry) => entry.defaultEnabled).map((entry) => entry.id);
  }

  const entries = mergeRegistryWithDiscovery(toolEntries, toolDiscovered);
  return { enabledIds, entries };
}

/** Upsert discovered items into registry, preserving operator overrides. */
export function mergeRegistryWithDiscovery(
  registry: ToolExtension[],
  discovered: DiscoveredExtension[]
): ToolExtension[] {
  const byId = new Map(registry.map((entry) => [entry.id, entry]));
  for (const item of discovered) {
    const existing = byId.get(item.id);
    if (existing) {
      byId.set(item.id, {
        ...existing,
        displayName: existing.displayName || item.displayName,
        source: existing.source || item.source,
        kind: existing.kind
      });
      continue;
    }
    byId.set(item.id, {
      id: item.id,
      toolId: item.toolId,
      kind: item.kind,
      displayName: item.displayName,
      source: item.source,
      detectedFrom: "disk",
      defaultEnabled: item.installed
    });
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}
