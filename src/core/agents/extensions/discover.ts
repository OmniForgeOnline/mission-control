import os from "node:os";

import type { AgentToolConfig } from "../config/types.ts";
import { discoverClaudeExtensions } from "./discover-claude.ts";
import { discoverCodexExtensions } from "./discover-codex.ts";
import { discoverCursorExtensions } from "./discover-cursor.ts";
import { discoverKiroExtensions } from "./discover-kiro.ts";
import type { DiscoverRoots, ExtensionDiscoveryResult } from "./types.ts";

export function defaultDiscoverRoots(projectDir?: string): DiscoverRoots {
  return {
    homeDir: os.homedir(),
    ...(projectDir ? { projectDir } : {})
  };
}

export async function discoverExtensionsForTool(
  tool: AgentToolConfig,
  roots?: DiscoverRoots
): Promise<ExtensionDiscoveryResult> {
  const resolvedRoots = roots ?? defaultDiscoverRoots();
  const errors: string[] = [];

  try {
    if (tool.adapter === "claude") {
      return { toolId: tool.id, discovered: await discoverClaudeExtensions(resolvedRoots), errors };
    }
    if (tool.adapter === "codex") {
      return { toolId: tool.id, discovered: await discoverCodexExtensions(resolvedRoots), errors };
    }
    if (tool.id === "kiro" || tool.adapter === "acp") {
      return { toolId: tool.id, discovered: await discoverKiroExtensions(resolvedRoots), errors };
    }
    if (tool.id === "cursor") {
      return { toolId: tool.id, discovered: await discoverCursorExtensions(resolvedRoots), errors };
    }
    return { toolId: tool.id, discovered: [], errors: [`Adapter "${tool.adapter}" has no extension discovery yet.`] };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { toolId: tool.id, discovered: [], errors };
  }
}

export async function discoverAllExtensions(
  tools: AgentToolConfig[],
  roots?: DiscoverRoots
): Promise<ExtensionDiscoveryResult[]> {
  const enabled = tools.filter((tool) => tool.enabled);
  return Promise.all(enabled.map((tool) => discoverExtensionsForTool(tool, roots)));
}
