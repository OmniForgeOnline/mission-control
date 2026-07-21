import type { ResolvedModelIdentity } from "../agents/identity-types.ts";
import type {
  RejectedCandidate,
  RoutingExplanation
} from "../agents/config/optimizer.ts";
import type { AgentConfigBundle, ModelPoolConfig } from "../agents/config/types.ts";
import {
  capacityStatus,
  indexUsage,
  type UsageSnapshots,
  type UsageState
} from "../agents/config/usage.ts";
import type { ModelPoolId, ToolId } from "../types.ts";

export type RoutingSource = "pin" | "preferred" | "optimizer-fallback";

/** Persisted routing audit metadata captured at run start: what actually ran. */
export interface RoutingDecisionRecord {
  harness: ToolId;
  modelPoolId: ModelPoolId;
  capability: string;
  source: RoutingSource;
  reason: string;
  provider: ResolvedModelIdentity["provider"];
  configuredModel: string;
  quotaState: UsageState;
  rankingBasis?: string;
  rejected: RejectedCandidate[];
  recordedAt: string;
}

export interface PinWarning {
  code: "unverified-identity" | "quota-nearing";
  message: string;
  requiresConfirmation: boolean;
}

export interface RoutingDecisionView {
  decision: RoutingDecisionRecord;
}

const STALE_USAGE_MS = 30 * 60 * 1000;

function usageIsStale(usage: UsageSnapshots): boolean {
  const refreshed = Date.parse(usage.refreshedAt);
  return !Number.isFinite(refreshed) || Date.now() - refreshed > STALE_USAGE_MS;
}

/** Operator pin warnings that require explicit confirmation before applying. */
export function assessPinWarnings(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  toolId: ToolId,
  pool: ModelPoolConfig
): PinWarning[] {
  const warnings: PinWarning[] = [];
  const verification = pool.identity?.verificationState ?? "unknown";
  if (verification !== "verified") {
    warnings.push({
      code: "unverified-identity",
      message: `Model pool "${pool.displayName}" uses an ${verification} identity.`,
      requiresConfirmation: true
    });
  }

  if (!usageIsStale(usage)) {
    const tool = bundle.tools.find((entry) => entry.id === toolId);
    if (tool) {
      const usageIndex = indexUsage(usage);
      const toolSnap = usageIndex.get(tool.id);
      const poolSnap = usageIndex.get(`${tool.id}::${pool.id}`) ?? toolSnap;
      const toolStatus = capacityStatus(tool.usage, toolSnap);
      const poolStatus = capacityStatus(pool.usage, poolSnap);
      if (toolStatus.state === "nearing" || poolStatus.state === "nearing") {
        warnings.push({
          code: "quota-nearing",
          message: "Provider quota is nearing its limit for this tool or model.",
          requiresConfirmation: true
        });
      }
    }
  }

  return warnings;
}

export function buildRoutingDecisionRecord(input: {
  harness: ToolId;
  modelPoolId: ModelPoolId;
  capability: string;
  source: RoutingSource;
  reason: string;
  identity: ResolvedModelIdentity;
  quotaState: UsageState;
  explanation?: RoutingExplanation | null;
  recordedAt?: string;
}): RoutingDecisionRecord {
  return {
    harness: input.harness,
    modelPoolId: input.modelPoolId,
    capability: input.capability,
    source: input.source,
    reason: input.reason,
    provider: input.identity.provider,
    configuredModel: input.identity.configuredModel,
    quotaState: input.quotaState,
    ...(input.explanation?.rankingBasis ? { rankingBasis: input.explanation.rankingBasis } : {}),
    rejected: input.explanation?.rejected ?? [],
    recordedAt: input.recordedAt ?? new Date().toISOString()
  };
}
