import type { RunnerAdapter } from "./types.ts";

/**
 * Per-agent live capability metadata. These describe what the underlying CLI
 * can do at runtime so the runner layer can pick a live, structured-stream, or
 * batch execution path and the UI can show the right controls.
 */
export interface AgentCapabilities {
  /** Streams incremental text/output events (vs. only a final blob). */
  streamOutput: boolean;
  /** Emits structured tool-call / tool-result events. */
  streamTools: boolean;
  /** Accepts operator messages on stdin while a turn is still running. */
  midTurnInput: boolean;
  /** Supports resuming a prior session by id. */
  sessionResume: boolean;
  /** Surfaces permission/approval requests as events. */
  permissionRequests: boolean;
  /** Provides its own filesystem sandbox/permission model. */
  nativeSandbox: boolean;
  /** Can be driven through a raw PTY terminal as a manual fallback. */
  rawTerminalFallback: boolean;
}

export const CAPABILITY_KEYS = [
  "streamOutput",
  "streamTools",
  "midTurnInput",
  "sessionResume",
  "permissionRequests",
  "nativeSandbox",
  "rawTerminalFallback"
] as const;

const GENERIC: AgentCapabilities = {
  streamOutput: false,
  streamTools: false,
  midTurnInput: false,
  sessionResume: false,
  permissionRequests: false,
  nativeSandbox: false,
  rawTerminalFallback: false
};

/**
 * Default capabilities per built-in adapter. Stored configs may override any
 * flag explicitly; absent flags fall back to these so existing installs gain
 * the metadata on upgrade without a migration step.
 */
export const ADAPTER_CAPABILITY_DEFAULTS: Record<RunnerAdapter, AgentCapabilities> = {
  claude: {
    streamOutput: true,
    streamTools: true,
    midTurnInput: true,
    sessionResume: true,
    permissionRequests: true,
    nativeSandbox: true,
    rawTerminalFallback: true
  },
  codex: {
    streamOutput: true,
    streamTools: true,
    midTurnInput: false,
    sessionResume: true,
    permissionRequests: false,
    nativeSandbox: true,
    rawTerminalFallback: true
  },
  opencode: {
    streamOutput: true,
    streamTools: true,
    midTurnInput: false,
    sessionResume: true,
    permissionRequests: false,
    nativeSandbox: true,
    rawTerminalFallback: true
  },
  grok: {
    streamOutput: true,
    streamTools: false,
    midTurnInput: false,
    sessionResume: true,
    permissionRequests: false,
    nativeSandbox: false,
    rawTerminalFallback: true
  },
  acp: {
    streamOutput: true,
    streamTools: true,
    midTurnInput: false,
    sessionResume: true,
    permissionRequests: true,
    nativeSandbox: true,
    rawTerminalFallback: false
  },
  generic: GENERIC
};

export function capabilitiesForAdapter(adapter: RunnerAdapter): AgentCapabilities {
  return ADAPTER_CAPABILITY_DEFAULTS[adapter] ?? GENERIC;
}

/** Coarse execution tier for operator-facing badges. */
export type CapabilityTier = "live" | "stream" | "batch";

export function capabilityTier(caps: { midTurnInput?: boolean; streamOutput?: boolean }): CapabilityTier {
  if (caps.midTurnInput) return "live";
  if (caps.streamOutput) return "stream";
  return "batch";
}

export function capabilityTierLabel(tier: CapabilityTier): string {
  switch (tier) {
    case "live":
      return "Live chat";
    case "stream":
      return "Live stream";
    default:
      return "Batch";
  }
}
