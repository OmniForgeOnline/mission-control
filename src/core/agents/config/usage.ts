import type { ModelPoolId, ToolId } from "../../types.ts";
import type { UsagePolicy } from "./types.ts";

export type UsageState = "available" | "nearing" | "exhausted" | "unknown";

/**
 * A single consumption reading.
 * Live provider quotas (codex/claude) are account-level: omit `modelPoolId`.
 * Per-pool keys are reserved for runtime exhaustion detection on a specific model.
 */
export interface UsageSnapshot {
  toolId: ToolId;
  modelPoolId?: ModelPoolId;
  /** Absolute consumption (harness-measured spend/tokens), when no percent is available. */
  used: number;
  /** Provider-reported percent of the gating window (0..100). Preferred when present. */
  usedPercent?: number;
  /** Duration of the gating window in minutes (for display). */
  windowMinutes?: number;
  /** Epoch seconds when the gating window resets. */
  resetsAt?: number;
  /** Short human label for the window (e.g. "weekly", "5h"). */
  windowLabel?: string;
  fetchedAt: string;
  periodStart?: string;
  source: "harness" | "manual" | "cli";
  /** Set when a live fetch failed; the UI can surface it without fabricating numbers. */
  error?: string;
}

export interface UsageSnapshots {
  snapshots: UsageSnapshot[];
  refreshedAt: string;
}

export function emptyUsageSnapshots(): UsageSnapshots {
  return { snapshots: [], refreshedAt: new Date(0).toISOString() };
}

function snapshotKey(toolId: ToolId, modelPoolId?: ModelPoolId): string {
  return modelPoolId ? `${toolId}::${modelPoolId}` : toolId;
}

/** Index snapshots by tool (and tool::pool) for O(1) lookup during routing. */
export function indexUsage(usage: UsageSnapshots): Map<string, UsageSnapshot> {
  const index = new Map<string, UsageSnapshot>();
  for (const snapshot of usage.snapshots) {
    index.set(snapshotKey(snapshot.toolId, snapshot.modelPoolId), snapshot);
  }
  return index;
}

/** Effective consumption for a tool/pool: prefer a manual policy override, then the snapshot. */
export function effectiveUsed(policy: UsagePolicy, snapshot?: UsageSnapshot): number {
  if (policy.used !== undefined) return policy.used;
  return snapshot?.used ?? 0;
}

export interface CapacityStatus {
  state: UsageState;
  used: number;
  limit?: number;
  /** Fraction of the period still available (1 = full, 0 = exhausted). 1 when uncapped. */
  remainingFraction: number;
}

/**
 * Capacity for a single usage policy.
 * - `unavailable`: no quota signal at all → unknown, never blocks, full headroom.
 * - `usage-only`: spend tracked but no cap → available, never blocks, full headroom.
 * - `quota`: compared against the limit; flips to nearing at the soft threshold.
 */
export function capacityStatus(policy: UsagePolicy, snapshot?: UsageSnapshot): CapacityStatus {
  // Provider-reported percent (codex/claude) takes precedence over the configured policy.
  if (snapshot?.usedPercent !== undefined) {
    const pct = Math.max(0, Math.min(100, snapshot.usedPercent));
    const remainingFraction = Math.max(0, (100 - pct) / 100);
    const soft = policy.kind === "quota" ? policy.softThresholdPercent ?? 80 : 80;
    let state: UsageState = "available";
    if (remainingFraction <= 0) state = "exhausted";
    else if (pct >= soft) state = "nearing";
    return { state, used: snapshot.used, limit: 100, remainingFraction };
  }

  const used = effectiveUsed(policy, snapshot);
  if (policy.kind === "unavailable") {
    return { state: "unknown", used: 0, remainingFraction: 1 };
  }
  if (policy.kind === "usage-only") {
    return { state: "available", used, remainingFraction: 1 };
  }
  const limit = policy.limit;
  if (limit === undefined || limit <= 0) {
    return { state: "unknown", used, remainingFraction: 1 };
  }
  const remainingFraction = Math.max(0, (limit - used) / limit);
  const consumedPercent = (used / limit) * 100;
  const soft = policy.softThresholdPercent ?? 80;
  let state: UsageState = "available";
  if (remainingFraction <= 0) state = "exhausted";
  else if (consumedPercent >= soft) state = "nearing";
  return { state, used, limit, remainingFraction };
}
