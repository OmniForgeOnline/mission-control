import type { AgentToolConfig } from "../core/agents/config/types.ts";
import type { ToolExtension } from "../core/agents/extensions/types.ts";
import { writeClaudeExtensionConfig } from "../core/agents/extensions/inject-claude.ts";
import {
  buildCodexExtensionOverrides,
  codexOverridesToCliArgs
} from "../core/agents/extensions/inject-codex.ts";
import { writeCursorExtensionConfig } from "../core/agents/extensions/inject-cursor.ts";
import { writeKiroExtensionConfig } from "../core/agents/extensions/inject-kiro.ts";

export { resolveGbrainLauncher, ensureGrokMcp, grokMcpArgFlags, grokMcpEntryMatchesHarness } from "./launcher-gbrain.ts";
export type { McpLaunch, McpConfigArgs } from "./launcher-types.ts";

import { writeGbrainMcpConfig } from "./launcher-gbrain.ts";
import type { McpConfigArgs } from "./launcher-types.ts";

export interface LaunchExtensionsInput {
  tool: AgentToolConfig;
  harnessRoot: string;
  runId: string;
  runDir: string;
  cwd: string;
  projectId?: string;
  /** Resolved extension entries for this tool. */
  extensions: ToolExtension[];
  /** Extension ids enabled for this launch. */
  enabledExtensionIds: string[];
}

/** Write gbrain MCP config plus scoped plugin/skill enablement for this launch. */
export async function writeLaunchExtensions(opts: LaunchExtensionsInput): Promise<McpConfigArgs> {
  const mcp = await writeGbrainMcpConfig({
    tool: opts.tool,
    harnessRoot: opts.harnessRoot,
    runId: opts.runId,
    runDir: opts.runDir,
    ...(opts.projectId ? { projectId: opts.projectId } : {})
  });

  if (opts.tool.adapter === "claude" && opts.extensions.length > 0) {
    const claude = await writeClaudeExtensionConfig({
      cwd: opts.cwd,
      allPlugins: opts.extensions,
      enabledIds: opts.enabledExtensionIds
    });
    return {
      ...mcp,
      extensionConfigPath: claude.settingsLocalPath
    };
  }

  if (opts.tool.adapter === "codex" && opts.extensions.length > 0) {
    const overrides = buildCodexExtensionOverrides(opts.extensions, opts.enabledExtensionIds);
    return {
      ...mcp,
      cliArgs: [...mcp.cliArgs, ...codexOverridesToCliArgs(overrides)]
    };
  }

  if ((opts.tool.id === "kiro" || opts.tool.adapter === "acp") && opts.extensions.length > 0) {
    const extensionConfigPath = await writeKiroExtensionConfig({
      cwd: opts.cwd,
      extensions: opts.extensions,
      enabledIds: opts.enabledExtensionIds
    });
    return { ...mcp, ...(extensionConfigPath ? { extensionConfigPath } : {}) };
  }

  if (opts.tool.id === "cursor" && opts.extensions.length > 0) {
    const extensionConfigPath = await writeCursorExtensionConfig({
      cwd: opts.cwd,
      extensions: opts.extensions,
      enabledIds: opts.enabledExtensionIds
    });
    return { ...mcp, ...(extensionConfigPath ? { extensionConfigPath } : {}) };
  }

  return mcp;
}

/** @deprecated Use writeLaunchExtensions. Kept for callers that only need gbrain MCP. */
export async function writeMcpConfig(opts: {
  tool: AgentToolConfig;
  harnessRoot: string;
  runId: string;
  runDir: string;
  projectId?: string;
  cwd?: string;
  extensions?: ToolExtension[];
  enabledExtensionIds?: string[];
}): Promise<McpConfigArgs> {
  return writeLaunchExtensions({
    ...opts,
    cwd: opts.cwd ?? opts.harnessRoot,
    extensions: opts.extensions ?? [],
    enabledExtensionIds: opts.enabledExtensionIds ?? []
  });
}
