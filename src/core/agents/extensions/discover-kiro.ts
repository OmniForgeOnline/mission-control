import path from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

import type { DiscoveredExtension, DiscoverRoots } from "./types.ts";

const TOOL_ID = "kiro";

/** Discover Kiro hooks/steering files (Phase 4 — headless scoping TBD). */
export async function discoverKiroExtensions(roots: DiscoverRoots): Promise<DiscoveredExtension[]> {
  const discovered: DiscoveredExtension[] = [];
  const hookDirs = [
    path.join(roots.homeDir, ".kiro", "hooks"),
    ...(roots.projectDir ? [path.join(roots.projectDir, ".kiro", "hooks")] : [])
  ];

  for (const dir of hookDirs) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = `kiro:hook:${entry.name.replace(/\.json$/, "")}`;
      discovered.push({
        id,
        toolId: TOOL_ID,
        kind: "subagent",
        displayName: entry.name,
        source: path.join(dir, entry.name),
        installed: true
      });
    }
  }

  return discovered;
}
