import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../../infra/fs.ts";
import type { ToolExtension } from "./types.ts";

export interface ClaudeExtensionLaunch {
  settingsLocalPath: string;
  enabledPlugins: Record<string, boolean>;
}

/** Build Claude enabledPlugins map: explicit true/false for all known plugins. */
export function buildClaudeEnabledPlugins(
  allPlugins: ToolExtension[],
  enabledIds: string[]
): Record<string, boolean> {
  const enabled = new Set(enabledIds);
  const map: Record<string, boolean> = {};
  for (const entry of allPlugins) {
    if (entry.kind !== "plugin") continue;
    map[entry.source] = enabled.has(entry.id);
  }
  return map;
}

/** Write worktree-local .claude/settings.local.json — never touches global config. */
export async function writeClaudeExtensionConfig(opts: {
  cwd: string;
  allPlugins: ToolExtension[];
  enabledIds: string[];
}): Promise<ClaudeExtensionLaunch> {
  const claudeDir = path.join(opts.cwd, ".claude");
  await ensureDir(claudeDir);
  const enabledPlugins = buildClaudeEnabledPlugins(opts.allPlugins, opts.enabledIds);
  const settingsLocalPath = path.join(claudeDir, "settings.local.json");
  const payload: { enabledPlugins: Record<string, boolean> } = { enabledPlugins };
  await writeFile(settingsLocalPath, JSON.stringify(payload, null, 2), "utf8");
  return { settingsLocalPath, enabledPlugins };
}
