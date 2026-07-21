import type { ModelPoolId, ToolId } from "../../types.ts";
import type { CapabilityFeature } from "../capability-profiles/types.ts";
import type { ModelPoolIdentity } from "../identity-types.ts";

export type { ModelPoolId, ToolId };

/** CLI launch knobs for a tool's adapter (output format, effort flag, permission modes). */
export interface AgentCliConfig {
  outputFormat?: string;
  promptAsArg?: boolean;
  effortFlag?: string;
  effortConfigKey?: string;
  permissionModes?: {
    plan?: string;
    execute?: string;
  };
  alwaysApproveInExecute?: boolean;
  /** Live execution capabilities. Defaulted per-adapter when absent (see capabilities.ts). */
  streamOutput?: boolean;
  streamTools?: boolean;
  midTurnInput?: boolean;
  sessionResume?: boolean;
  permissionRequests?: boolean;
  nativeSandbox?: boolean;
  rawTerminalFallback?: boolean;
}

/** Runner adapters. Built-ins keep bespoke launch behavior; `generic` uses command templates. */
export type RunnerAdapter = "codex" | "claude" | "grok" | "opencode" | "acp" | "generic";
export type PromptTransport = "stdin" | "argv" | "file";
export type PromptInputFormat = "text" | "stream-json";
export type ExternalMcpInjection = "claude-mcp-json" | "acp-merge" | "opencode-env-content";

/**
 * How a tool/model reports consumption:
 * - `quota`: tracked against a numeric limit over a period.
 * - `usage-only`: provider percent may be tracked, but there is no configured cap.
 * - `unavailable`: no reliable usage signal exists.
 */
export type UsagePolicyKind = "quota" | "usage-only" | "unavailable";

export type QuotaPeriod = "daily" | "weekly" | "monthly";

export type ModelTier = "free" | "paid";

/** Capability tags a model pool can satisfy (workflow roles + free-form capabilities). */
export type Capability = string;

/**
 * How live usage is fetched for a model pool's provider:
 * - `codex-app-server`: spawn `codex app-server` and read account rate limits (JSON-RPC).
 * - `claude-oauth`: read the Claude OAuth token and GET Anthropic's oauth/usage endpoint.
 * - `none`: no live source.
 */
export type UsageSource = "codex-app-server" | "claude-oauth" | "none";

export type {
  ModelPoolIdentity,
  ModelProviderId,
  VerificationState
} from "../identity-types.ts";

export interface UsagePolicy {
  kind: UsagePolicyKind;
  /** Quota window. Required when kind === "quota". */
  period?: QuotaPeriod;
  /** Numeric cap for the period. Required when kind === "quota". */
  limit?: number;
  /** Manual provider-reported spend override. */
  used?: number;
  /** Percent of limit that flips the pool/tool into "nearing" state. */
  softThresholdPercent?: number;
}

/** Interactive install / login helpers for Settings (terminal modal). */
export interface AgentToolSetup {
  /** Shell command typed into an interactive login shell to install the CLI. */
  installShell?: string;
  /** Shell command to start vendor login (OAuth / API key). */
  loginShell?: string;
  /** Optional docs link shown next to Install / Login. */
  docsUrl?: string;
}

export interface AgentToolConfig {
  id: ToolId;
  displayName: string;
  /** Binary name resolved through the login shell. */
  command: string;
  adapter: RunnerAdapter;
  enabled: boolean;
  /** Seeded templates are builtin; user-defined tools are not. */
  builtin: boolean;
  supportsEffort: boolean;
  cli: AgentCliConfig;
  /**
   * Argument template for the `generic` adapter. Tokens: {prompt}, {model}, {effort}, {cwd}.
   * Ignored by built-in adapters.
   */
  commandTemplate?: string[];
  /** Complete generic-adapter argument template for read-only launches. */
  readOnlyCommandTemplate?: string[];
  promptTransport?: PromptTransport;
  promptInputFormat?: PromptInputFormat;
  maxPromptArgBytes?: number;
  fallbackCommands?: string[];
  versionArgs?: string[];
  helpArgs?: string[];
  capabilityFlags?: Record<string, string>;
  authProbe?: {
    args: string[];
    timeoutMs?: number;
  };
  /** Optional Install / Login terminal bootstrap for Settings. */
  setup?: AgentToolSetup;
  streamFormat?: string;
  eventParser?: string;
  externalMcpInjection?: ExternalMcpInjection;
  supportsCustomModel?: boolean;
  inactivityTimeoutMs?: number;
  resumesSessionViaCli?: boolean;
  usage: UsagePolicy;
}

export interface ModelPoolConfig {
  id: ModelPoolId;
  /** Owning tool. */
  toolId: ToolId;
  displayName: string;
  /** Args injected to select this model (e.g. ["--model", "glm-5.1"]). */
  modelArgs: string[];
  /** Env vars injected when launching this model (e.g. base URL / API key var names). */
  modelEnv: Record<string, string>;
  capabilities: Capability[];
  /** Explicit routing features (vision/tool-use/large-context/custom-provider). */
  features?: CapabilityFeature[];
  tier: ModelTier;
  /** Per-pool usage policy. May differ from the owning tool (e.g. capless GLM-5.1). */
  usage: UsagePolicy;
  /** How to fetch live usage for this pool's provider. Defaults to "none". */
  usageSource: UsageSource;
  enabled: boolean;
  builtin: boolean;
  /** Verified provider/model identity for this pool. Populated by normalization. */
  identity?: ModelPoolIdentity;
}

/**
 * Maps a workflow role (author/reviewer/...) or capability to routing constraints.
 * The optimizer resolves a role into a concrete {toolId, modelPoolId}.
 */
export interface RoutingProfileConfig {
  /** Workflow role or capability this profile governs. */
  role: string;
  /** Required capability a model pool must advertise. Defaults to `role`. */
  requiredCapability?: Capability;
  /** Optional explicit preference order of tool ids (still subject to hard filters). */
  preferToolIds?: ToolId[];
}

export interface AgentConfigBundle {
  tools: AgentToolConfig[];
  pools: ModelPoolConfig[];
  profiles: RoutingProfileConfig[];
}
