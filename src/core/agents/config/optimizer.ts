import type { ModelPoolId, ToolId } from "../../types.ts";
import { poolSupportsRequiredFeatures } from "./pool-features.ts";
import type { CapabilityFeature } from "../capability-profiles/types.ts";
import { capacityStatus, indexUsage, type CapacityStatus, type UsageSnapshots } from "./usage.ts";
import type {
  AgentConfigBundle,
  AgentToolConfig,
  ModelPoolConfig,
  RoutingProfileConfig
} from "./types.ts";

/** Usage snapshots older than this are not trusted for exhaustion gating. */
const STALE_USAGE_MS = 30 * 60 * 1000;

export type RejectReason =
  | "disabled"
  | "missing-capability"
  | "missing-feature"
  | "tool-disabled"
  | "not-installed"
  | "quota-exhausted"
  | "incompatible-identity";

export interface RejectedCandidate {
  toolId: ToolId;
  modelPoolId: ModelPoolId;
  reason: RejectReason;
  detail?: string;
}

export interface RoutingExplanation {
  capability: string;
  candidateCount: number;
  rejected: RejectedCandidate[];
  rankingBasis: string;
}

export interface RouteRequest {
  /** Workflow role (author/reviewer/...) or capability to route. */
  role: string;
  /** Capability the model pool must advertise. Falls back to the profile or the role. */
  capability?: string;
  /** Features a pool must support (vision, tool-use, ...). */
  requiredFeatures?: CapabilityFeature[];
  /** When provided, only tools whose command is installed are eligible. */
  installedToolIds?: Set<ToolId>;
  /** Workflow tool preference; ranked first but may fall back when ineligible. */
  preferredToolId?: ToolId;
}

export interface RouteResult {
  toolId: ToolId;
  modelPoolId: ModelPoolId;
  tier: ModelPoolConfig["tier"];
  reason: string;
  explanation: RoutingExplanation;
}

interface Candidate {
  tool: AgentToolConfig;
  pool: ModelPoolConfig;
  /** Lower of the tool/pool remaining fractions; drives quota tie-breaking. */
  headroom: number;
}

function profileFor(bundle: AgentConfigBundle, role: string): RoutingProfileConfig | undefined {
  return bundle.profiles.find((profile) => profile.role === role);
}

function isExhausted(status: CapacityStatus): boolean {
  return status.state === "exhausted";
}

function usageIsStale(usage: UsageSnapshots): boolean {
  const refreshed = Date.parse(usage.refreshedAt);
  return !Number.isFinite(refreshed) || Date.now() - refreshed > STALE_USAGE_MS;
}

function reject(
  toolId: ToolId,
  modelPoolId: ModelPoolId,
  reason: RejectReason,
  detail?: string
): RejectedCandidate {
  return { toolId, modelPoolId, reason, ...(detail ? { detail } : {}) };
}

function evaluatePool(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  request: RouteRequest,
  capability: string,
  pool: ModelPoolConfig,
  rejected: RejectedCandidate[]
): Candidate | null {
  if (!pool.enabled) {
    rejected.push(reject(pool.toolId, pool.id, "disabled"));
    return null;
  }
  if (capability && !pool.capabilities.includes(capability)) {
    rejected.push(reject(pool.toolId, pool.id, "missing-capability", capability));
    return null;
  }

  const toolsById = new Map(bundle.tools.map((tool) => [tool.id, tool]));
  const tool = toolsById.get(pool.toolId);
  if (!tool || !tool.enabled) {
    rejected.push(reject(pool.toolId, pool.id, "tool-disabled"));
    return null;
  }
  if (request.installedToolIds && !request.installedToolIds.has(tool.id)) {
    rejected.push(reject(pool.toolId, pool.id, "not-installed"));
    return null;
  }
  if (!poolSupportsRequiredFeatures(tool, pool, request.requiredFeatures)) {
    const missing = request.requiredFeatures?.find(
      (feature) => !poolSupportsRequiredFeatures(tool, pool, [feature])
    );
    rejected.push(reject(pool.toolId, pool.id, "missing-feature", missing));
    return null;
  }

  const staleUsage = usageIsStale(usage);
  const usageIndex = indexUsage(usage);
  const toolSnap = usageIndex.get(tool.id);
  const poolSnap = usageIndex.get(`${tool.id}::${pool.id}`) ?? toolSnap;
  const toolStatus = capacityStatus(tool.usage, toolSnap);
  const poolStatus = capacityStatus(pool.usage, poolSnap);
  if (!staleUsage && (isExhausted(toolStatus) || isExhausted(poolStatus))) {
    rejected.push(reject(pool.toolId, pool.id, "quota-exhausted"));
    return null;
  }

  return {
    tool,
    pool,
    headroom: Math.min(toolStatus.remainingFraction, poolStatus.remainingFraction)
  };
}

function gatherCandidates(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  request: RouteRequest,
  capability: string,
  rejected: RejectedCandidate[]
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const pool of bundle.pools) {
    const candidate = evaluatePool(bundle, usage, request, capability, pool, rejected);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function preferToolIds(request: RouteRequest, profile: RoutingProfileConfig | undefined): ToolId[] {
  const ids = [...(profile?.preferToolIds ?? [])];
  if (request.preferredToolId && !ids.includes(request.preferredToolId)) {
    ids.unshift(request.preferredToolId);
  }
  return ids;
}

function compareCandidates(a: Candidate, b: Candidate, preferToolIds: ToolId[]): number {
  const aPref = preferToolIds.indexOf(a.tool.id);
  const bPref = preferToolIds.indexOf(b.tool.id);
  if (aPref !== bPref) {
    const an = aPref === -1 ? Number.POSITIVE_INFINITY : aPref;
    const bn = bPref === -1 ? Number.POSITIVE_INFINITY : bPref;
    return an - bn;
  }
  if (a.pool.tier !== b.pool.tier) return a.pool.tier === "free" ? -1 : 1;
  if (a.headroom !== b.headroom) return b.headroom - a.headroom;
  return a.pool.id.localeCompare(b.pool.id);
}

function describe(candidate: Candidate, role: string): string {
  const tierLabel = candidate.pool.tier === "free" ? "free" : "paid";
  return `routed ${role} → ${candidate.tool.id}/${candidate.pool.id} (${tierLabel})`;
}

function rankingBasis(staleUsage: boolean): string {
  return staleUsage
    ? "preferred-tool, tier, headroom, pool-id (stale usage: quota not trusted)"
    : "preferred-tool, tier, headroom, pool-id";
}

/**
 * Resolve a workflow role into a concrete tool + model pool.
 * Eligibility: enabled, capability, installed, required features, non-exhausted quota.
 * Ranking: preferred tool, then tier, quota headroom, pool id.
 */
export function routeAgent(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  request: RouteRequest
): RouteResult | null {
  const profile = profileFor(bundle, request.role);
  const capability = request.capability ?? profile?.requiredCapability ?? request.role;
  const toolPrefs = preferToolIds(request, profile);
  const rejected: RejectedCandidate[] = [];

  const candidates = gatherCandidates(bundle, usage, request, capability, rejected);
  if (candidates.length === 0) return null;

  const onPreferred = request.preferredToolId
    ? candidates.filter((candidate) => candidate.tool.id === request.preferredToolId)
    : candidates;
  const poolCandidates = onPreferred.length > 0 ? onPreferred : candidates;

  poolCandidates.sort((a, b) => compareCandidates(a, b, toolPrefs));
  const chosen = poolCandidates[0]!;
  const staleUsage = usageIsStale(usage);
  return {
    toolId: chosen.tool.id,
    modelPoolId: chosen.pool.id,
    tier: chosen.pool.tier,
    reason: describe(chosen, request.role),
    explanation: {
      capability,
      candidateCount: poolCandidates.length,
      rejected,
      rankingBasis: rankingBasis(staleUsage)
    }
  };
}

/** Validate an operator-pinned pool against routing constraints. */
function pinRouteRequest(request: RouteRequest): RouteRequest {
  const { installedToolIds: _ignored, ...rest } = request;
  return rest;
}

export type PinValidationResult =
  | { ok: true; pool: ModelPoolConfig; reason: string }
  | { ok: false; reason: RejectReason; detail: string };

export function validatePinnedPool(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  request: RouteRequest,
  toolId: ToolId,
  modelPoolId: ModelPoolId
): PinValidationResult {
  const pinRequest = pinRouteRequest(request);
  const pool = bundle.pools.find((entry) => entry.id === modelPoolId);
  if (!pool) {
    return { ok: false, reason: "incompatible-identity", detail: `Model pool "${modelPoolId}" is not registered.` };
  }
  if (pool.toolId !== toolId) {
    return {
      ok: false,
      reason: "incompatible-identity",
      detail: `Model pool "${modelPoolId}" belongs to "${pool.toolId}", not "${toolId}".`
    };
  }
  const profile = profileFor(bundle, pinRequest.role);
  const capability = pinRequest.capability ?? profile?.requiredCapability ?? pinRequest.role;
  const rejected: RejectedCandidate[] = [];
  const candidate = evaluatePool(bundle, usage, pinRequest, capability, pool, rejected);
  if (!candidate) {
    const first = rejected[0]!;
    return {
      ok: false,
      reason: first.reason,
      detail: first.detail ?? `Pinned pool "${modelPoolId}" is not eligible.`
    };
  }
  return {
    ok: true,
    pool,
    reason: `pinned ${request.role} → ${toolId}/${modelPoolId}`
  };
}

export function formatPinRouteFailure(
  toolId: ToolId,
  modelPoolId: ModelPoolId,
  validation: Extract<PinValidationResult, { ok: false }>
): string {
  return (
    `Pinned model pool "${modelPoolId}" for tool "${toolId}" cannot run: ${validation.detail} ` +
    `Clear the pin or choose an eligible pool in Settings → Agents.`
  );
}

/** Build a human-facing message when no tool/model can serve a role. */
export function formatNoRouteMessage(bundle: AgentConfigBundle, role: string): string {
  const profile = profileFor(bundle, role);
  const capability = profile?.requiredCapability ?? role;
  return (
    `No tool/model can serve role "${role}" (capability "${capability}"). ` +
    `All matching pools are disabled, not installed, or exhausted. ` +
    `Adjust tools, model pools, or provider-backed usage in Settings → Agents.`
  );
}
