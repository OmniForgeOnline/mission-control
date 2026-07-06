import path from "node:path";

import { readJsonFile, updateJsonFile, writeJsonFile } from "../../infra/fs.ts";
import { ensureHarnessRepository } from "../../bootstrap/repository.ts";
import { normalizeExtension, normalizeRegistry } from "./normalize.ts";
import type { ExtensionRegistry, ToolExtension } from "./types.ts";

function registryPath(root: string): string {
  return path.join(root, "data", "state", "agent-extensions.json");
}

const EMPTY: ExtensionRegistry = { extensions: [] };

export async function loadExtensionRegistry(root: string): Promise<ExtensionRegistry> {
  await ensureHarnessRepository(root);
  const stored = await readJsonFile<unknown>(registryPath(root), null);
  if (!stored) {
    await writeJsonFile(registryPath(root), EMPTY);
    return { ...EMPTY };
  }
  return normalizeRegistry(stored);
}

async function mutateRegistry(
  root: string,
  mutator: (registry: ExtensionRegistry) => ExtensionRegistry
): Promise<ExtensionRegistry> {
  await ensureHarnessRepository(root);
  await loadExtensionRegistry(root);
  return updateJsonFile<ExtensionRegistry>(registryPath(root), EMPTY, (current) =>
    normalizeRegistry(mutator(normalizeRegistry(current)))
  );
}

export async function upsertExtension(root: string, extension: ToolExtension): Promise<ExtensionRegistry> {
  const normalized = normalizeExtension(extension);
  return mutateRegistry(root, (registry) => {
    const index = registry.extensions.findIndex((entry) => entry.id === normalized.id);
    const extensions = [...registry.extensions];
    if (index === -1) extensions.push(normalized);
    else extensions[index] = normalized;
    return { ...registry, extensions };
  });
}

export async function removeExtension(root: string, extensionId: string): Promise<ExtensionRegistry> {
  return mutateRegistry(root, (registry) => ({
    ...registry,
    extensions: registry.extensions.filter((entry) => entry.id !== extensionId)
  }));
}

export async function replaceDiscoveredExtensions(
  root: string,
  extensions: ToolExtension[],
  discoveredAt: string
): Promise<ExtensionRegistry> {
  return mutateRegistry(root, (registry) => {
    const manual = registry.extensions.filter((entry) => entry.detectedFrom === "manual");
    const manualIds = new Set(manual.map((entry) => entry.id));
    const merged = [...manual];
    for (const entry of extensions) {
      if (manualIds.has(entry.id)) continue;
      const existing = registry.extensions.find((item) => item.id === entry.id);
      merged.push(
        existing
          ? {
              ...entry,
              defaultEnabled: existing.defaultEnabled,
              displayName: existing.displayName || entry.displayName
            }
          : entry
      );
    }
    return { extensions: merged.sort((a, b) => a.displayName.localeCompare(b.displayName)), lastDiscoveredAt: discoveredAt };
  });
}
