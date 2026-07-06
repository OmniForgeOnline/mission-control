import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { DiscoveredExtension, DiscoverRoots } from "./types.ts";

const TOOL_ID = "cursor";

/** Discover Cursor rules/skills (Phase 4 — ACP headless scoping TBD). */
export async function discoverCursorExtensions(roots: DiscoverRoots): Promise<DiscoveredExtension[]> {
  const discovered: DiscoveredExtension[] = [];
  const skillDirs = [
    path.join(roots.homeDir, ".cursor", "skills"),
    ...(roots.projectDir ? [path.join(roots.projectDir, ".cursor", "skills")] : [])
  ];

  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      discovered.push({
        id: `cursor:skill:${entry.name}`,
        toolId: TOOL_ID,
        kind: "skill",
        displayName: entry.name,
        source: skillFile,
        installed: true
      });
    }
  }

  return discovered;
}
