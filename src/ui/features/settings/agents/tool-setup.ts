import type { AgentToolConfig } from "../../../../core/agents/config/types.ts";

export type ToolRuntimePresence = {
  available: boolean;
  command?: string;
};

export type ToolSetupMode = "install" | "login";

export type ToolPresenceMap = Record<string, ToolRuntimePresence | undefined>;

/** Which Install / Login / Enable / Rescan controls a tool card should show. */
export function toolSetupActions(
  tool: AgentToolConfig,
  presence: ToolRuntimePresence | undefined
): {
  available: boolean | undefined;
  showEnable: boolean;
  showInstall: boolean;
  showLogin: boolean;
  showRescan: boolean;
} {
  const available = presence?.available;
  return {
    available,
    showEnable: available === true && !tool.enabled,
    showInstall: available === false && Boolean(tool.setup?.installShell),
    showLogin: available === true && Boolean(tool.setup?.loginShell),
    showRescan: true
  };
}

export function setupShellCommand(tool: AgentToolConfig, mode: ToolSetupMode): string | undefined {
  return mode === "install" ? tool.setup?.installShell : tool.setup?.loginShell;
}

/** First-run checklist: at least one enabled tool is available on PATH. */
export function cliSetupDone(
  tools: readonly AgentToolConfig[],
  presence: ToolPresenceMap
): boolean {
  return tools.some((tool) => tool.enabled && presence[tool.id]?.available === true);
}
