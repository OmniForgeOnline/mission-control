import type { ModelPoolId, ToolId } from "../../types.ts";
import { capacityStatus, indexUsage, type CapacityStatus, type UsageSnapshots } from "./usage.ts";
import type {
  AgentConfigBundle,
  AgentToolConfig,
  ModelPoolConfig,
  RoutingProfileConfig
} from "./types.ts";

/** Quality points below the best in-band candidate still considered acceptable. */
const QUALITY_BAND = 15;

export interface RouteRequest {
  /** Workflow role (author/reviewer/...) or capability to route. */
  role: string;
  /** Capability the model pool must advertise. Falls back to the profile or the role. */
  capability?: string;
  /** When provided, only tools whose command is installed are eligible. */
  installedToolIds?: Set<ToolId>;
}

export interface RouteResult {
  toolId: ToolId;
  modelPoolId: ModelPoolId;
  qualityWeight: number;
  tier: ModelPoolConfig["tier"];
  reason: string;
}

interface Candidate {
  tool: AgentToolConfig;
  pool: ModelPoolConfig;
  quality: number;
  /** Lower of the tool/pool remaining fractions; drives quota tie-breaking. */
  headroom: number;
}

function profileFor(bundle: AgentConfigBundle, role: string): RoutingProfileConfig | undefined {
  return bundle.profiles.find((profile) => profile.role === role);
}

function isExhausted(status: CapacityStatus): boolean {
  return status.state === "exhausted";
}

function gatherCandidates(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  request: RouteRequest,
  capability: string,
  minQuality: number
): Candidate[] {
  const usageIndex = indexUsage(usage);
  const toolsById = new Map(bundle.tools.map((tool) => [tool.id, tool]));
  const candidates: Candidate[] = [];

  for (const pool of bundle.pools) {
    if (!pool.enabled) continue;
    if (capability && !pool.capabilities.includes(capability)) continue;
    if (pool.qualityWeight < minQuality) continue;

    const tool = toolsById.get(pool.toolId);
    if (!tool || !tool.enabled) continue;
    if (request.installedToolIds && !request.installedToolIds.has(tool.id)) continue;

    // Live quotas are account/tool-scoped; pool-keyed snaps (e.g. runtime exhaustion) override.
    const toolSnap = usageIndex.get(tool.id);
    const poolSnap = usageIndex.get(`${tool.id}::${pool.id}`) ?? toolSnap;
    const toolStatus = capacityStatus(tool.usage, toolSnap);
    const poolStatus = capacityStatus(pool.usage, poolSnap);
    if (isExhausted(toolStatus) || isExhausted(poolStatus)) continue;

    candidates.push({
      tool,
      pool,
      quality: pool.qualityWeight,
      headroom: Math.min(toolStatus.remainingFraction, poolStatus.remainingFraction)
    });
  }
  return candidates;
}

function compareCandidates(a: Candidate, b: Candidate, preferToolIds: ToolId[]): number {
  // 1. Explicit operator preference order (strongest in-band signal).
  const aPref = preferToolIds.indexOf(a.tool.id);
  const bPref = preferToolIds.indexOf(b.tool.id);
  if (aPref !== bPref) {
    const an = aPref === -1 ? Number.POSITIVE_INFINITY : aPref;
    const bn = bPref === -1 ? Number.POSITIVE_INFINITY : bPref;
    return an - bn;
  }
  // 2. Free beats paid inside the acceptable band.
  if (a.pool.tier !== b.pool.tier) return a.pool.tier === "free" ? -1 : 1;
  // 3. More quota headroom (deprioritizes "nearing" pools).
  if (a.headroom !== b.headroom) return b.headroom - a.headroom;
  // 4. Higher quality.
  if (a.quality !== b.quality) return b.quality - a.quality;
  // 5. Stable by id.
  return a.pool.id.localeCompare(b.pool.id);
}

function describe(candidate: Candidate, role: string): string {
  const tierLabel = candidate.pool.tier === "free" ? "free" : "paid";
  return `routed ${role} → ${candidate.tool.id}/${candidate.pool.id} (quality ${candidate.quality}, ${tierLabel})`;
}

/**
 * Resolve a workflow role into a concrete tool + model pool.
 * Quality first, then quota headroom and cost tier; free/cheap pools win only
 * inside the acceptable quality band.
 */
export function routeAgent(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  request: RouteRequest
): RouteResult | null {
  const profile = profileFor(bundle, request.role);
  const capability = request.capability ?? profile?.requiredCapability ?? request.role;
  const minQuality = profile?.minQuality ?? 0;
  const preferToolIds = profile?.preferToolIds ?? [];

  const candidates = gatherCandidates(bundle, usage, request, capability, minQuality);
  if (candidates.length === 0) return null;

  const bestQuality = Math.max(...candidates.map((candidate) => candidate.quality));
  const band = candidates.filter((candidate) => candidate.quality >= bestQuality - QUALITY_BAND);
  band.sort((a, b) => compareCandidates(a, b, preferToolIds));

  const chosen = band[0]!;
  return {
    toolId: chosen.tool.id,
    modelPoolId: chosen.pool.id,
    qualityWeight: chosen.quality,
    tier: chosen.pool.tier,
    reason: describe(chosen, request.role)
  };
}

/** Build a human-facing message when no tool/model can serve a role. */
export function formatNoRouteMessage(bundle: AgentConfigBundle, role: string): string {
  const profile = profileFor(bundle, role);
  const capability = profile?.requiredCapability ?? role;
  return (
    `No tool/model can serve role "${role}" (capability "${capability}"). ` +
    `All matching pools are disabled, exhausted, or below the minimum quality. ` +
    `Adjust tools, model pools, or provider-backed usage in Settings → Agents.`
  );
}

/**
 * Pick the best model pool for an explicitly chosen tool (operator override or
 * workflow step agent). Respects enabled/exhausted filters and the role
 * capability when one is advertised, then orders free → headroom → quality.
 */
export function bestPoolForTool(
  bundle: AgentConfigBundle,
  usage: UsageSnapshots,
  toolId: ToolId,
  role: string
): ModelPoolConfig | null {
  const profile = profileFor(bundle, role);
  const capability = profile?.requiredCapability ?? role;
  const onTool = (list: Candidate[]): Candidate[] =>
    list.filter((candidate) => candidate.tool.id === toolId);

  let candidates = onTool(gatherCandidates(bundle, usage, { role, capability }, capability, 0));
  if (candidates.length === 0) {
    // No capability-matched pool; fall back to any enabled, non-exhausted pool on the tool.
    candidates = onTool(gatherCandidates(bundle, usage, { role, capability: "" }, "", 0));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareCandidates(a, b, []));
  return candidates[0]!.pool;
}
