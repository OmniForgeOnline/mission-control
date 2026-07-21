import { resolveRunIdentityFromRouting } from "../agents/config/run-identity.ts";
import {
  routeAgent,
  validatePinnedPool,
  type RouteRequest,
  type RoutingExplanation
} from "../agents/config/optimizer.ts";
import { loadAgentConfig } from "../agents/config/store.ts";
import { capacityStatus, indexUsage, type UsageSnapshots, type UsageState } from "../agents/config/usage.ts";
import { loadUsageSnapshots } from "../agents/config/usage-store.ts";
import {
  resolveAgentForStep,
  resolveStepRouting,
  type ResolvedRouting,
  type SessionPoolHint
} from "../agents/stage-agents.ts";
import { buildRouteRequest, enrichRouteRequest, roleCapability } from "../agents/stage-routing.ts";
import type { HarnessTask, ModelPoolId, ToolId } from "../types.ts";
import { loadWorkflow } from "../workflows/index.ts";
import {
  assessPinWarnings,
  buildRoutingDecisionRecord,
  type PinWarning,
  type RoutingDecisionView
} from "./routing-decision.ts";
import { listAllRuns } from "../tasks/runs.ts";

const STALE_USAGE_MS = 30 * 60 * 1000;

function usageIsStale(usage: UsageSnapshots): boolean {
  const refreshed = Date.parse(usage.refreshedAt);
  return !Number.isFinite(refreshed) || Date.now() - refreshed > STALE_USAGE_MS;
}

export function quotaStateForPool(
  bundle: Awaited<ReturnType<typeof loadAgentConfig>>,
  usage: UsageSnapshots,
  toolId: ToolId,
  poolId: ModelPoolId
): UsageState {
  const tool = bundle.tools.find((entry) => entry.id === toolId);
  const pool = bundle.pools.find((entry) => entry.id === poolId);
  if (!tool || !pool) return "unknown";
  if (usageIsStale(usage)) return "unknown";

  const usageIndex = indexUsage(usage);
  const toolSnap = usageIndex.get(tool.id);
  const poolSnap = usageIndex.get(`${tool.id}::${pool.id}`) ?? toolSnap;
  const toolStatus = capacityStatus(tool.usage, toolSnap);
  const poolStatus = capacityStatus(pool.usage, poolSnap);
  const states = [toolStatus.state, poolStatus.state];
  if (states.includes("exhausted")) return "exhausted";
  if (states.includes("nearing")) return "nearing";
  if (states.includes("unknown")) return "unknown";
  return "available";
}

export interface StepRoutingContext {
  routing: ResolvedRouting;
  routeRequest: RouteRequest;
  explanation: RoutingExplanation | null;
}

export async function resolveStepRoutingContext(
  root: string,
  workflowId: string,
  stepId: string,
  taskOverrides?: Partial<Record<string, ToolId>>,
  taskModelPoolOverrides?: Partial<Record<string, ModelPoolId>>,
  cwd?: string,
  sessionPoolHint?: SessionPoolHint
): Promise<StepRoutingContext | null> {
  const routing = await resolveStepRouting(
    root,
    workflowId,
    stepId,
    taskOverrides,
    taskModelPoolOverrides,
    cwd,
    sessionPoolHint
  );
  if (!routing) return null;

  const [bundle, usage] = await Promise.all([loadAgentConfig(root), loadUsageSnapshots(root)]);
  const workflow = await loadWorkflow(root, workflowId);
  const step = workflow.steps[stepId];
  const capability = roleCapability(step?.agent);
  const routeRequest = await enrichRouteRequest(
    root,
    bundle,
    buildRouteRequest(capability, workflowId, step, routing.preferred),
    cwd,
    { includeInstalledToolIds: false }
  );

  if (routing.source === "pin") {
    return { routing, routeRequest, explanation: null };
  }

  const routed = routeAgent(bundle, usage, routeRequest);
  return {
    routing,
    routeRequest,
    explanation: routed?.explanation ?? null
  };
}

export async function inspectStepRoutingDecision(
  root: string,
  task: HarnessTask,
  stepId: string
): Promise<RoutingDecisionView | null> {
  if (!task.workflowRun) return null;
  const context = await resolveStepRoutingContext(
    root,
    task.workflowRun.workflowId,
    stepId,
    task.stageAgentOverrides,
    task.stageModelPoolOverrides,
    undefined,
    task.agentSessionId && task.agentSessionAgent && task.agentSessionModelPool
      ? { agent: task.agentSessionAgent, modelPoolId: task.agentSessionModelPool }
      : undefined
  );
  if (!context) return null;

  const identity = await resolveRunIdentityFromRouting(root, context.routing.toolId, context.routing.modelPoolId);
  if (!identity) return null;

  const bundle = await loadAgentConfig(root);
  const usage = await loadUsageSnapshots(root);
  const capability = context.explanation?.capability ?? roleCapability((await loadWorkflow(root, task.workflowRun.workflowId)).steps[stepId]?.agent);

  const decision = buildRoutingDecisionRecord({
    harness: context.routing.toolId,
    modelPoolId: context.routing.modelPoolId,
    capability,
    source: context.routing.source,
    reason: context.routing.routeReason ?? context.routing.source,
    identity,
    quotaState: quotaStateForPool(bundle, usage, context.routing.toolId, context.routing.modelPoolId),
    explanation: context.explanation
  });

  return { decision };
}

export async function inspectRunRoutingDecision(
  root: string,
  runId: string
): Promise<RoutingDecisionView | null> {
  const run = (await listAllRuns(root)).find((candidate) => candidate.id === runId);
  if (!run) return null;

  const view: RoutingDecisionView | null = run.routingDecision
    ? { decision: run.routingDecision }
    : run.resolvedIdentity
      ? {
          decision: {
            harness: run.agent,
            modelPoolId: run.modelPoolId ?? run.agent,
            capability: "unknown",
            source: "preferred",
            reason: "recorded before routing audit",
            provider: run.resolvedIdentity.provider,
            configuredModel: run.resolvedIdentity.configuredModel,
            quotaState: "unknown",
            rejected: [],
            recordedAt: run.startedAt
          }
        }
      : null;

  if (!view) return null;

  return view;
}

export async function previewTaskStageModelPoolPin(
  root: string,
  task: HarnessTask,
  stepId: string,
  poolId: ModelPoolId
): Promise<{ ok: true; warnings: PinWarning[] } | { ok: false; error: string }> {
  if (!task.workflowRun) {
    return { ok: false, error: "Task has no workflow run." };
  }

  const workflow = await loadWorkflow(root, task.workflowRun.workflowId);
  const step = workflow.steps[stepId];
  if (!step || step.agent === "none") {
    return { ok: false, error: `Step "${stepId}" does not use an agent.` };
  }

  const [bundle, usage] = await Promise.all([loadAgentConfig(root), loadUsageSnapshots(root)]);
  const preferred = await resolveAgentForStep(
    root,
    task.workflowRun.workflowId,
    stepId,
    task.stageAgentOverrides
  );
  if (!preferred) {
    return { ok: false, error: `No agent configured for step "${stepId}".` };
  }

  const routeRequest = await enrichRouteRequest(
    root,
    bundle,
    buildRouteRequest(roleCapability(step.agent), task.workflowRun.workflowId, step, preferred),
    undefined,
    { includeInstalledToolIds: false }
  );
  const validation = validatePinnedPool(bundle, usage, routeRequest, preferred, poolId);
  if (!validation.ok) {
    return { ok: false, error: validation.detail };
  }

  const pool = bundle.pools.find((entry) => entry.id === poolId);
  if (!pool) {
    return { ok: false, error: `Model pool "${poolId}" is not registered.` };
  }

  return { ok: true, warnings: assessPinWarnings(bundle, usage, preferred, pool) };
}
