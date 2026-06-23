import type { AgentConfigBundle, AgentToolConfig, ModelPoolConfig, RoutingProfileConfig } from "./types.ts";

/**
 * Built-in tool/model templates. These preserve the bespoke launch behavior of
 * Codex, Claude Code, and Grok Build that the runner adapters special-case.
 */
const CODEX_TOOL: AgentToolConfig = {
  id: "codex",
  displayName: "Codex",
  command: "codex",
  adapter: "codex",
  enabled: true,
  builtin: true,
  supportsEffort: true,
  effortLevels: ["low", "medium", "high"],
  cli: {
    outputFormat: "json",
    promptAsArg: false,
    effortConfigKey: "model_reasoning_effort",
    permissionModes: { plan: "read-only", execute: "workspace-write" }
  },
  promptTransport: "stdin",
  promptInputFormat: "text",
  fallbackCommands: [],
  versionArgs: ["--version"],
  helpArgs: [],
  capabilityFlags: {},
  streamFormat: "json-event-stream",
  eventParser: "codex",
  supportsCustomModel: true,
  resumesSessionViaCli: true,
  usage: { kind: "usage-only", softThresholdPercent: 80 }
};

const CLAUDE_TOOL: AgentToolConfig = {
  id: "claude",
  displayName: "Claude Code",
  command: "claude",
  adapter: "claude",
  enabled: true,
  builtin: true,
  supportsEffort: true,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  cli: {
    outputFormat: "stream-json",
    promptAsArg: false,
    effortFlag: "--effort",
    permissionModes: { plan: "plan", execute: "dangerously-skip-permissions" }
  },
  promptTransport: "stdin",
  promptInputFormat: "stream-json",
  fallbackCommands: ["openclaude"],
  versionArgs: ["--version"],
  helpArgs: ["-p", "--help"],
  capabilityFlags: {
    "--include-partial-messages": "partialMessages",
    "--add-dir": "addDir"
  },
  streamFormat: "claude-stream-json",
  eventParser: "claude",
  externalMcpInjection: "claude-mcp-json",
  supportsCustomModel: true,
  resumesSessionViaCli: true,
  usage: { kind: "usage-only", softThresholdPercent: 80 }
};

const GROK_TOOL: AgentToolConfig = {
  id: "grok",
  displayName: "Grok Build",
  command: "agent",
  adapter: "grok",
  enabled: true,
  builtin: true,
  supportsEffort: false,
  effortLevels: [],
  cli: {
    outputFormat: "streaming-json",
    promptAsArg: true,
    permissionModes: { plan: "plan", execute: "bypassPermissions" },
    alwaysApproveInExecute: true
  },
  promptTransport: "argv",
  maxPromptArgBytes: 30_000,
  fallbackCommands: [],
  versionArgs: ["--version"],
  helpArgs: [],
  capabilityFlags: {},
  streamFormat: "grok-streaming-json",
  eventParser: "grok",
  supportsCustomModel: true,
  resumesSessionViaCli: true,
  usage: { kind: "unavailable" }
};

const OPENCODE_TOOL: AgentToolConfig = {
  id: "opencode",
  displayName: "OpenCode",
  command: "opencode",
  adapter: "opencode",
  enabled: true,
  builtin: true,
  supportsEffort: true,
  effortLevels: ["low", "medium", "high", "max"],
  cli: {
    outputFormat: "json",
    promptAsArg: true,
    effortFlag: "--variant",
    permissionModes: { plan: "plan", execute: "dangerously-skip-permissions" }
  },
  promptTransport: "stdin",
  promptInputFormat: "text",
  fallbackCommands: ["opencode-cli"],
  versionArgs: ["--version"],
  helpArgs: [],
  capabilityFlags: {},
  streamFormat: "json-event-stream",
  eventParser: "opencode",
  externalMcpInjection: "opencode-env-content",
  supportsCustomModel: true,
  resumesSessionViaCli: true,
  usage: { kind: "unavailable" }
};

const CODEX_POOL: ModelPoolConfig = {
  id: "codex-default",
  toolId: "codex",
  displayName: "Codex (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 80,
  tier: "paid",
  usage: { kind: "usage-only", softThresholdPercent: 80 },
  usageSource: "codex-app-server",
  enabled: true,
  builtin: true
};

const CLAUDE_POOL: ModelPoolConfig = {
  id: "claude-default",
  toolId: "claude",
  displayName: "Claude (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 90,
  tier: "paid",
  usage: { kind: "usage-only", softThresholdPercent: 80 },
  usageSource: "claude-oauth",
  enabled: true,
  builtin: true
};

const GROK_POOL: ModelPoolConfig = {
  id: "grok-default",
  toolId: "grok",
  displayName: "Grok (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 70,
  tier: "paid",
  usage: { kind: "unavailable" },
  usageSource: "none",
  enabled: true,
  builtin: true
};

const OPENCODE_POOL: ModelPoolConfig = {
  id: "opencode-default",
  toolId: "opencode",
  displayName: "OpenCode (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 75,
  tier: "paid",
  usage: { kind: "unavailable" },
  usageSource: "none",
  enabled: true,
  builtin: true
};

const DEFAULT_PROFILES: RoutingProfileConfig[] = [
  { role: "author", requiredCapability: "author", minQuality: 0 },
  { role: "reviewer", requiredCapability: "reviewer", minQuality: 0 }
];

const KIRO_TOOL: AgentToolConfig = {
  id: "kiro",
  displayName: "Kiro CLI",
  command: "kiro-cli",
  adapter: "acp",
  enabled: true,
  builtin: true,
  supportsEffort: false,
  effortLevels: [],
  // ACP is JSON-RPC over stdio (not flag-driven); live capabilities are filled
  // from the adapter defaults in normalize.ts.
  cli: {},
  promptTransport: "stdin",
  promptInputFormat: "text",
  fallbackCommands: [],
  versionArgs: ["--version"],
  helpArgs: [],
  capabilityFlags: {},
  streamFormat: "acp-json-rpc",
  eventParser: "acp",
  externalMcpInjection: "acp-merge",
  supportsCustomModel: false,
  resumesSessionViaCli: true,
  usage: { kind: "unavailable" }
};

const KIRO_POOL: ModelPoolConfig = {
  id: "kiro-default",
  toolId: "kiro",
  displayName: "Kiro (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 85,
  tier: "paid",
  usage: { kind: "unavailable" },
  usageSource: "none",
  enabled: true,
  builtin: true
};

export function builtinAgentConfigBundle(): AgentConfigBundle {
  return {
    tools: [CODEX_TOOL, CLAUDE_TOOL, GROK_TOOL, OPENCODE_TOOL, KIRO_TOOL].map((tool) => ({ ...tool })),
    pools: [CODEX_POOL, CLAUDE_POOL, GROK_POOL, OPENCODE_POOL, KIRO_POOL].map((pool) => ({ ...pool })),
    profiles: DEFAULT_PROFILES.map((profile) => ({ ...profile }))
  };
}
