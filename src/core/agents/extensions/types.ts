import type { ToolId } from "../../types.ts";

export type ExtensionKind = "plugin" | "skill" | "subagent" | "mcp";

export type ExtensionDetectedFrom = "disk" | "manual";

/** Registry entry persisted in agent-extensions.json. */
export interface ToolExtension {
  id: string;
  toolId: ToolId;
  kind: ExtensionKind;
  displayName: string;
  /** Manifest ref, path, or plugin@marketplace key. */
  source: string;
  detectedFrom: ExtensionDetectedFrom;
  /** Default for launches with no step binding. false = opt-in per step. */
  defaultEnabled: boolean;
}

export interface ExtensionRegistry {
  extensions: ToolExtension[];
  lastDiscoveredAt?: string;
}

/** Ephemeral discovery result merged with registry on read. */
export interface DiscoveredExtension {
  id: string;
  toolId: ToolId;
  kind: ExtensionKind;
  displayName: string;
  source: string;
  /** Whether the tool's global config currently has this enabled. */
  installed: boolean;
}

export interface ExtensionDiscoveryResult {
  toolId: ToolId;
  discovered: DiscoveredExtension[];
  errors: string[];
}

export interface ResolvedExtensionLaunch {
  /** Extension ids to enable for this launch. */
  enabledIds: string[];
  /** Full registry entries for the resolved tool. */
  entries: ToolExtension[];
}

export interface DiscoverRoots {
  /** User-level config root (defaults to os.homedir()). */
  homeDir: string;
  /** Project/worktree directory for project-scoped discovery. */
  projectDir?: string;
}
