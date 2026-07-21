import type { ToolId } from "../../types.ts";
import type { AgentToolConfig } from "../config/types.ts";
import { resolveRuntimeCommand } from "./launch.ts";

/**
 * Resolve tool ids whose CLI command is available on PATH.
 * Returns undefined when no installs are detected so routing does not over-filter.
 */
export function resolveInstalledToolIds(
  tools: AgentToolConfig[],
  cwd: string
): Set<ToolId> | undefined {
  const installed = new Set<ToolId>();
  for (const tool of tools) {
    if (!tool.enabled) continue;
    if (resolveRuntimeCommand(tool, cwd).command) {
      installed.add(tool.id);
    }
  }
  return installed.size > 0 ? installed : undefined;
}
