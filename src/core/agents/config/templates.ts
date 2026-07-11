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

const CLAUDE_MODELS: Array<[string, string, number]> = [
  ["Fable", "claude-fable-5", 95],
  ["Opus 4.8", "claude-opus-4-8", 90],
  ["Sonnet 5", "claude-sonnet-5", 80],
  ["Sonnet 4.5", "claude-sonnet-4-5", 70],
  ["Haiku 4.5", "claude-haiku-4-5-20251001", 50]
];
const CLAUDE_POOLS: ModelPoolConfig[] = CLAUDE_MODELS.map(([displayName, modelId, qualityWeight]) => ({
  id: modelId,
  toolId: "claude",
  displayName,
  modelArgs: ["--model", modelId],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight,
  tier: "paid",
  usage: { kind: "usage-only", softThresholdPercent: 80 },
  usageSource: "claude-oauth",
  enabled: true,
  builtin: true
}));

const GROK_MODELS: Array<[string, string, number]> = [
  ["Grok Build 0.1", "grok-build-0.1", 80],
  ["Composer 2.5", "grok-composer-2.5", 75],
  ["Grok 4.5", "grok-4.5", 70]
];
const GROK_POOLS: ModelPoolConfig[] = GROK_MODELS.map(([displayName, modelId, qualityWeight]) => ({
  id: modelId,
  toolId: "grok",
  displayName,
  modelArgs: ["--model", modelId],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight,
  tier: "paid",
  usage: { kind: "unavailable" },
  usageSource: "none",
  enabled: true,
  builtin: true
}));

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

const KIRO_MODELS: Array<[string, string, number]> = [
  ["Fable", "claude-fable-5", 95],
  ["Opus 4.8", "claude-opus-4-8", 90],
  ["Sonnet 5", "claude-sonnet-5", 80],
  ["Sonnet 4.5", "claude-sonnet-4-5", 70],
  ["Haiku 4.5", "claude-haiku-4-5-20251001", 50]
];
const KIRO_POOLS: ModelPoolConfig[] = KIRO_MODELS.map(([displayName, modelId, qualityWeight]) => ({
  id: `kiro-${modelId}`,
  toolId: "kiro",
  displayName,
  modelArgs: ["--model", modelId],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight,
  tier: "paid",
  usage: { kind: "unavailable" },
  usageSource: "none",
  enabled: true,
  builtin: true
}));

// "Default" pools pass no --model, so the tool runs with whatever model it is
// currently configured against (codex config.toml, claude/z.ai settings, etc.).
// This is the safe default; the named pools below only apply when explicitly pinned.
const CLAUDE_DEFAULT_POOL: ModelPoolConfig = {
  id: "claude-default",
  toolId: "claude",
  displayName: "Claude (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 50,
  tier: "paid",
  usage: { kind: "usage-only", softThresholdPercent: 80 },
  usageSource: "claude-oauth",
  enabled: true,
  builtin: true
};

const GROK_DEFAULT_POOL: ModelPoolConfig = {
  id: "grok-default",
  toolId: "grok",
  displayName: "Grok (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 50,
  tier: "paid",
  usage: { kind: "unavailable" },
  usageSource: "none",
  enabled: true,
  builtin: true
};

const KIRO_DEFAULT_POOL: ModelPoolConfig = {
  id: "kiro-default",
  toolId: "kiro",
  displayName: "Kiro (default)",
  modelArgs: [],
  modelEnv: {},
  capabilities: ["author", "reviewer", "code", "plan", "review"],
  qualityWeight: 50,
  tier: "paid",
  usage: { kind: "unavailable" },
  usageSource: "none",
  enabled: true,
  builtin: true
};

export function builtinAgentConfigBundle(): AgentConfigBundle {
  return {
    tools: [CODEX_TOOL, CLAUDE_TOOL, GROK_TOOL, OPENCODE_TOOL, KIRO_TOOL].map((tool) => ({ ...tool })),
    pools: [
      CODEX_POOL,
      CLAUDE_DEFAULT_POOL,
      ...CLAUDE_POOLS,
      GROK_DEFAULT_POOL,
      ...GROK_POOLS,
      OPENCODE_POOL,
      KIRO_DEFAULT_POOL,
      ...KIRO_POOLS
    ].map((pool) => ({ ...pool })),
    profiles: DEFAULT_PROFILES.map((profile) => ({ ...profile }))
  };
}
