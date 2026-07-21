import path from "node:path";

import { readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import { loadHarnessSettings } from "../settings.ts";
import { loadAgentConfig } from "./config/store.ts";
import { loadUsageSnapshots } from "./config/usage-store.ts";
import {
  formatNoRouteMessage,
  formatPinRouteFailure,
  routeAgent,
  validatePinnedPool
} from "./config/optimizer.ts";
import type { AgentConfigBundle } from "./config/types.ts";
import { buildRouteRequest, enrichRouteRequest, roleCapability } from "./stage-routing.ts";
import type { ModelPoolId, ToolId } from "../types.ts";
import {
  assertValidWorkflowStep,
  isWorkflowAgentTool,
  loadAllWorkflows,
  loadWorkflow,
  resolveStepAgent,
  type WorkflowDefinition
} from "../workflows/index.ts";
import { resolveStepExtensions } from "./extensions/launch.ts";
import type { ToolExtension } from "./extensions/types.ts";
import {
  loadStageModelPoolOverrides,
  lookupStageModelPoolOverride
} from "./stage-model-pools.ts";

export interface StageAgentOverrides {
  overrides: Record<string, ToolId>;
  /** Legacy step-only keys that match multiple workflows; require explicit operator choice. */
  ambiguousLegacy?: Record<string, ToolId>;
}

export function stageOverrideKey(workflowId: string, stepId: string): string {
  return `${workflowId}:${stepId}`;
}

export function isScopedOverrideKey(key: string): boolean {
  return key.includes(":");
}

export function lookupStageAgentOverride(
  overrides: StageAgentOverrides,
  workflowId: string,
  stepId: string
): ToolId | undefined {
  return overrides.overrides[stageOverrideKey(workflowId, stepId)];
}

export interface ResolvedStageAgent {
  stage: string;
  role: string;
  agent: ToolId | null;
  source: "override" | "step" | "workflow-default" | "harness-default" | "none";
  override?: ToolId;
}

/** A fully resolved routing decision: a concrete tool + model pool for a role. */
export interface ResolvedRouting {
  toolId: ToolId;
  modelPoolId: ModelPoolId;
  preferred: ToolId;
  source: "preferred" | "optimizer-fallback" | "pin";
  supportsEffort: boolean;
  /** Resolved extension ids to enable for this launch. */
  extensions: string[];
  /** Full extension entries for launch injection. */
  extensionEntries: ToolExtension[];
  /** Human-readable routing decision from the optimizer. */
  routeReason?: string;
}

function stageAgentsPath(root: string): string {
  return path.join(root, "data", "state", "stage-agents.json");
}

async function migrateLegacyStageOverrides(
  root: string,
  config: StageAgentOverrides
): Promise<{ config: StageAgentOverrides; migrated: boolean }> {
  const workflows = await loadAllWorkflows(root);
  const stepToWorkflows = new Map<string, string[]>();
  for (const [workflowId, workflow] of workflows) {
    for (const stepId of Object.keys(workflow.steps)) {
      const owners = stepToWorkflows.get(stepId) ?? [];
      owners.push(workflowId);
      stepToWorkflows.set(stepId, owners);
    }
  }

  let migrated = false;
  const nextOverrides = { ...config.overrides };
  const ambiguousLegacy = { ...config.ambiguousLegacy };

  for (const [key, agent] of Object.entries(config.overrides)) {
    if (isScopedOverrideKey(key)) continue;

    const owners = stepToWorkflows.get(key) ?? [];
    delete nextOverrides[key];
    migrated = true;

    if (owners.length === 1) {
      nextOverrides[stageOverrideKey(owners[0]!, key)] = agent;
    } else {
      ambiguousLegacy[key] = agent;
    }
  }

  const nextConfig: StageAgentOverrides = {
    overrides: nextOverrides,
    ...(Object.keys(ambiguousLegacy).length ? { ambiguousLegacy } : {})
  };
  return { config: nextConfig, migrated };
}

export async function loadStageAgentOverrides(root: string): Promise<StageAgentOverrides> {
  await ensureHarnessRepository(root);
  const raw = await readJsonFile<StageAgentOverrides>(stageAgentsPath(root), { overrides: {} });
  const { config, migrated } = await migrateLegacyStageOverrides(root, raw);
  if (migrated) {
    await saveStageAgentOverrides(root, config);
  }
  return config;
}

/**
 * Whether `agentId` is a registered agent tool. The agent dropdown is built from
 * the agent config bundle's tools, so that bundle is the single source of truth
 * for which agents are eligible to be assigned to a workflow step.
 */
export async function isRegisteredAgent(root: string, agentId: string): Promise<boolean> {
  const bundle = await loadAgentConfig(root);
  return bundle.tools.some((tool) => tool.id === agentId);
}

export function unregisteredAgentMessage(agentId: string): string {
  return `Agent "${agentId}" is not registered. Choose an agent from the dropdown.`;
}

/**
 * Whether `poolId` is a registered model pool. The model dropdown is filtered
 * from the agent config bundle's pools, so that bundle is the single source of
 * truth for which pools are eligible to be pinned to a workflow step.
 */
export async function isRegisteredModelPool(root: string, poolId: string): Promise<boolean> {
  const bundle = await loadAgentConfig(root);
  return bundle.pools.some((pool) => pool.id === poolId);
}

export function unregisteredModelPoolMessage(poolId: string): string {
  return `Model pool "${poolId}" is not registered. Choose a model from the dropdown.`;
}

async function saveStageAgentOverrides(root: string, config: StageAgentOverrides): Promise<void> {
  await writeJsonFile(stageAgentsPath(root), config);
}

export async function setStageAgentOverride(
  root: string,
  stage: string,
  agent: ToolId,
  workflowId = "code-feature"
): Promise<StageAgentOverrides> {
  const workflow = await loadWorkflow(root, workflowId);
  assertValidWorkflowStep(workflow, stage);
  const step = workflow.steps[stage]!;
  if (step.agent === "none") {
    throw new Error(`Step "${stage}" does not use an agent.`);
  }
  const agentConfig = await loadAgentConfig(root);
  const tool = agentConfig.tools.find((entry) => entry.id === agent);
  if (!tool) throw new Error(unregisteredAgentMessage(agent));
  if (!tool.enabled) throw new Error(`Agent "${agent}" is disabled.`);
  const overrides = await loadStageAgentOverrides(root);
  overrides.overrides[stageOverrideKey(workflowId, stage)] = agent;
  await saveStageAgentOverrides(root, overrides);
  return overrides;
}

export async function bulkSetStageAgentOverrides(
  root: string,
  stages: string[],
  agent: ToolId,
  workflowId = "code-feature"
): Promise<StageAgentOverrides> {
  if (!stages.length) {
    throw new Error("At least one stage is required.");
  }
  const workflow = await loadWorkflow(root, workflowId);
  const config = await loadStageAgentOverrides(root);
  const agentConfig = await loadAgentConfig(root);
  for (const stage of stages) {
    assertValidWorkflowStep(workflow, stage);
    const step = workflow.steps[stage]!;
    if (step.agent === "none") {
      throw new Error(`Step "${stage}" does not use an agent.`);
    }
    const tool = agentConfig.tools.find((entry) => entry.id === agent);
    if (!tool) throw new Error(unregisteredAgentMessage(agent));
    if (!tool.enabled) throw new Error(`Agent "${agent}" is disabled.`);
    config.overrides[stageOverrideKey(workflowId, stage)] = agent;
  }
  await saveStageAgentOverrides(root, config);
  return config;
}

export async function clearStageAgentOverride(
  root: string,
  stage: string,
  workflowId = "code-feature"
): Promise<StageAgentOverrides> {
  const workflow = await loadWorkflow(root, workflowId);
  assertValidWorkflowStep(workflow, stage);
  const config = await loadStageAgentOverrides(root);
  delete config.overrides[stageOverrideKey(workflowId, stage)];
  await saveStageAgentOverrides(root, config);
  return config;
}

export async function adoptAmbiguousLegacyOverride(
  root: string,
  stepId: string,
  workflowId: string
): Promise<StageAgentOverrides> {
  const config = await loadStageAgentOverrides(root);
  const agent = config.ambiguousLegacy?.[stepId];
  if (!agent) {
    throw new Error(`No ambiguous legacy override for step "${stepId}".`);
  }
  await setStageAgentOverride(root, stepId, agent, workflowId);
  const validated = await loadStageAgentOverrides(root);
  const nextAmbiguous = { ...validated.ambiguousLegacy };
  delete nextAmbiguous[stepId];
  if (Object.keys(nextAmbiguous).length) {
    validated.ambiguousLegacy = nextAmbiguous;
  } else {
    delete validated.ambiguousLegacy;
  }
  await saveStageAgentOverrides(root, validated);
  return validated;
}

export async function resolveAgentForStep(
  root: string,
  workflowId: string,
  stepId: string,
  taskOverrides?: Partial<Record<string, ToolId>>
): Promise<ToolId | null> {
  const [workflow, overrides, settings] = await Promise.all([
    loadWorkflow(root, workflowId),
    loadStageAgentOverrides(root),
    loadHarnessSettings(root)
  ]);
  return resolveStepAgent(workflow, overrides, stepId, settings.defaultAgent, taskOverrides);
}

function toolSupportsEffort(bundle: AgentConfigBundle, toolId: ToolId): boolean {
  return bundle.tools.find((tool) => tool.id === toolId)?.supportsEffort ?? false;
}

function routingFromResult(
  bundle: AgentConfigBundle,
  preferred: ToolId,
  routed: NonNullable<ReturnType<typeof routeAgent>>,
  extensions: string[],
  extensionEntries: ResolvedRouting["extensionEntries"],
  source: ResolvedRouting["source"]
): ResolvedRouting {
  return {
    toolId: routed.toolId,
    modelPoolId: routed.modelPoolId,
    preferred,
    source,
    supportsEffort: toolSupportsEffort(bundle, routed.toolId),
    extensions,
    extensionEntries,
    routeReason: routed.reason
  };
}

export interface SessionPoolHint {
  agent: ToolId;
  modelPoolId: ModelPoolId;
}

export async function resolveStepRouting(
  root: string,
  workflowId: string,
  stepId: string,
  taskOverrides?: Partial<Record<string, ToolId>>,
  taskModelPoolOverrides?: Partial<Record<string, ModelPoolId>>,
  cwd?: string,
  sessionPoolHint?: SessionPoolHint
): Promise<ResolvedRouting | null> {
  const [workflow, overrides, modelPoolOverrides, settings, bundle, usage] = await Promise.all([
    loadWorkflow(root, workflowId),
    loadStageAgentOverrides(root),
    loadStageModelPoolOverrides(root),
    loadHarnessSettings(root),
    loadAgentConfig(root),
    loadUsageSnapshots(root)
  ]);
  const step = workflow.steps[stepId];
  const preferred = resolveStepAgent(workflow, overrides, stepId, settings.defaultAgent, taskOverrides);
  if (!preferred) return null;

  const resolvedExtensions = await resolveStepExtensions({
    root,
    toolId: preferred,
    ...(step ? { step } : {}),
    ...(cwd ? { cwd } : {})
  });

  const capability = roleCapability(step?.agent);
  const routeRequest = await enrichRouteRequest(
    root,
    bundle,
    buildRouteRequest(capability, workflowId, step, preferred),
    cwd,
    { includeInstalledToolIds: false }
  );

  const pinRouting = (
    poolId: ModelPoolId,
    source: ResolvedRouting["source"],
    reason: string
  ): ResolvedRouting | null => {
    const validation = validatePinnedPool(bundle, usage, routeRequest, preferred, poolId);
    if (!validation.ok) return null;
    return {
      toolId: preferred,
      modelPoolId: poolId,
      preferred,
      source,
      supportsEffort: toolSupportsEffort(bundle, preferred),
      extensions: resolvedExtensions.enabledIds,
      extensionEntries: resolvedExtensions.entries,
      routeReason: reason
    };
  };

  if (taskModelPoolOverrides?.[stepId]) {
    return pinRouting(taskModelPoolOverrides[stepId]!, "pin", `pinned ${capability} → ${preferred}/${taskModelPoolOverrides[stepId]}`);
  }

  if (sessionPoolHint && sessionPoolHint.agent === preferred) {
    const resumed = pinRouting(
      sessionPoolHint.modelPoolId,
      "preferred",
      `resume session pool → ${preferred}/${sessionPoolHint.modelPoolId}`
    );
    if (resumed) return resumed;
  }

  const workflowPoolId = lookupStageModelPoolOverride(modelPoolOverrides, workflowId, stepId);
  if (workflowPoolId && !taskModelPoolOverrides?.[stepId]) {
    const pool = bundle.pools.find((entry) => entry.id === workflowPoolId);
    if (pool?.toolId === preferred) {
      return pinRouting(
        workflowPoolId,
        "preferred",
        `workflow default → ${preferred}/${workflowPoolId}`
      );
    }
  }

  const routed = routeAgent(bundle, usage, routeRequest);
  if (!routed) return null;
  return routingFromResult(
    bundle,
    preferred,
    routed,
    resolvedExtensions.enabledIds,
    resolvedExtensions.entries,
    routed.toolId === preferred ? "preferred" : "optimizer-fallback"
  );
}

export async function resolveHarnessDefaultRouting(root: string): Promise<ResolvedRouting | null> {
  const [settings, bundle, usage] = await Promise.all([
    loadHarnessSettings(root),
    loadAgentConfig(root),
    loadUsageSnapshots(root)
  ]);
  const resolvedExtensions = await resolveStepExtensions({ root, toolId: settings.defaultAgent });
  const routeRequest = await enrichRouteRequest(
    root,
    bundle,
    buildRouteRequest("author", "code-feature", undefined, settings.defaultAgent),
    undefined,
    { includeInstalledToolIds: false }
  );
  const routed = routeAgent(bundle, usage, routeRequest);
  if (!routed) return null;
  return routingFromResult(
    bundle,
    settings.defaultAgent,
    routed,
    resolvedExtensions.enabledIds,
    resolvedExtensions.entries,
    routed.toolId === settings.defaultAgent ? "preferred" : "optimizer-fallback"
  );
}

export async function formatStepNoRouteMessage(
  root: string,
  workflowId: string,
  stepId: string,
  taskOverrides?: Partial<Record<string, ToolId>>,
  taskModelPoolOverrides?: Partial<Record<string, ModelPoolId>>
): Promise<string> {
  const [workflow, overrides, modelPoolOverrides, bundle, usage] = await Promise.all([
    loadWorkflow(root, workflowId),
    loadStageAgentOverrides(root),
    loadStageModelPoolOverrides(root),
    loadAgentConfig(root),
    loadUsageSnapshots(root)
  ]);
  const step = workflow.steps[stepId];
  const settings = await loadHarnessSettings(root);
  const preferred = resolveStepAgent(workflow, overrides, stepId, settings.defaultAgent, taskOverrides);
  if (!preferred) {
    return `No agent configured for workflow step "${stepId}".`;
  }
  const capability = roleCapability(step?.agent);
  const routeRequest = await enrichRouteRequest(
    root,
    bundle,
    buildRouteRequest(capability, workflowId, step, preferred),
    undefined,
    { includeInstalledToolIds: false }
  );
  const overridePoolId =
    taskModelPoolOverrides?.[stepId] ??
    lookupStageModelPoolOverride(modelPoolOverrides, workflowId, stepId);
  if (taskModelPoolOverrides?.[stepId]) {
    const validation = validatePinnedPool(bundle, usage, routeRequest, preferred, taskModelPoolOverrides[stepId]!);
    if (!validation.ok) {
      return formatPinRouteFailure(preferred, taskModelPoolOverrides[stepId]!, validation);
    }
  } else if (overridePoolId) {
    const pool = bundle.pools.find((entry) => entry.id === overridePoolId);
    if (pool?.toolId === preferred) {
      const validation = validatePinnedPool(bundle, usage, routeRequest, preferred, overridePoolId);
      if (!validation.ok) {
        return formatPinRouteFailure(preferred, overridePoolId, validation);
      }
    }
  }
  return formatNoRouteMessage(bundle, capability);
}

export function buildResolvedStageAgents(
  workflow: WorkflowDefinition,
  overrides: StageAgentOverrides,
  defaultAgent: ToolId
): ResolvedStageAgent[] {
  return Object.entries(workflow.steps).map(([stage, step]) => {
    const override = lookupStageAgentOverride(overrides, workflow.id, stage);
    const agent = resolveStepAgent(workflow, overrides, stage, defaultAgent);
    const source: ResolvedStageAgent["source"] =
      step.agent === "none"
        ? "none"
        : override
          ? "override"
          : isWorkflowAgentTool(step.agent)
            ? "step"
            : step.agent === "author" || step.agent === "reviewer"
              ? "workflow-default"
              : "harness-default";
    return {
      stage,
      role: step.agent,
      agent,
      source,
      ...(override ? { override } : {})
    };
  });
}
