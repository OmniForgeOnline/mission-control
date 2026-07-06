import path from "node:path";

import { readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import { loadHarnessSettings } from "../settings.ts";
import { loadAgentConfig } from "./config/store.ts";
import { loadUsageSnapshots } from "./config/usage-store.ts";
import { bestPoolForTool, formatNoRouteMessage, routeAgent } from "./config/optimizer.ts";
import type { AgentConfigBundle } from "./config/types.ts";
import type { ModelPoolId, ToolId } from "../types.ts";
import {
  assertValidWorkflowStep,
  isWorkflowAgentTool,
  loadWorkflow,
  resolveStepAgent,
  type WorkflowDefinition
} from "../workflows/index.ts";
import { resolveStepExtensions } from "./extensions/launch.ts";
import type { ToolExtension } from "./extensions/types.ts";

export interface StageAgentOverrides {
  overrides: Record<string, ToolId>;
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
  source: "preferred" | "optimizer-fallback";
  supportsEffort: boolean;
  /** Resolved extension ids to enable for this launch. */
  extensions: string[];
  /** Full extension entries for launch injection. */
  extensionEntries: ToolExtension[];
}

function stageAgentsPath(root: string): string {
  return path.join(root, "data", "state", "stage-agents.json");
}

export async function loadStageAgentOverrides(root: string): Promise<StageAgentOverrides> {
  await ensureHarnessRepository(root);
  return readJsonFile<StageAgentOverrides>(stageAgentsPath(root), { overrides: {} });
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
  const config = await loadStageAgentOverrides(root);
  config.overrides[stage] = agent;
  await saveStageAgentOverrides(root, config);
  return config;
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
  for (const stage of stages) {
    assertValidWorkflowStep(workflow, stage);
    const step = workflow.steps[stage]!;
    if (step.agent === "none") {
      throw new Error(`Step "${stage}" does not use an agent.`);
    }
    config.overrides[stage] = agent;
  }
  await saveStageAgentOverrides(root, config);
  return config;
}

export async function clearStageAgentOverride(root: string, stage: string): Promise<StageAgentOverrides> {
  const config = await loadStageAgentOverrides(root);
  delete config.overrides[stage];
  await saveStageAgentOverrides(root, config);
  return config;
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

/** Capability a model pool must advertise for a workflow role. */
function roleCapability(stepAgent: string | undefined): string {
  return stepAgent === "reviewer" ? "reviewer" : "author";
}

function toolSupportsEffort(bundle: AgentConfigBundle, toolId: ToolId): boolean {
  return bundle.tools.find((tool) => tool.id === toolId)?.supportsEffort ?? false;
}

/**
 * Resolve a preferred tool into a concrete {tool, model pool}. When the preferred
 * tool has no eligible pool (disabled/exhausted), the optimizer routes the role to
 * the best alternative. Returns null when nothing can serve the role.
 */
function routeWithPreferred(
  bundle: AgentConfigBundle,
  usage: Awaited<ReturnType<typeof loadUsageSnapshots>>,
  preferred: ToolId,
  capability: string,
  extensions: string[],
  extensionEntries: ResolvedRouting["extensionEntries"]
): ResolvedRouting | null {
  const pool = bestPoolForTool(bundle, usage, preferred, capability);
  if (pool) {
    return {
      toolId: preferred,
      modelPoolId: pool.id,
      preferred,
      source: "preferred",
      supportsEffort: toolSupportsEffort(bundle, preferred),
      extensions,
      extensionEntries
    };
  }
  const routed = routeAgent(bundle, usage, { role: capability, capability });
  if (!routed) return null;
  return {
    toolId: routed.toolId,
    modelPoolId: routed.modelPoolId,
    preferred,
    source: "optimizer-fallback",
    supportsEffort: toolSupportsEffort(bundle, routed.toolId),
    extensions,
    extensionEntries
  };
}

export async function resolveStepRouting(
  root: string,
  workflowId: string,
  stepId: string,
  taskOverrides?: Partial<Record<string, ToolId>>,
  cwd?: string
): Promise<ResolvedRouting | null> {
  const [workflow, overrides, settings, bundle, usage] = await Promise.all([
    loadWorkflow(root, workflowId),
    loadStageAgentOverrides(root),
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

  return routeWithPreferred(
    bundle,
    usage,
    preferred,
    roleCapability(step?.agent),
    resolvedExtensions.enabledIds,
    resolvedExtensions.entries
  );
}

export async function resolveHarnessDefaultRouting(root: string): Promise<ResolvedRouting | null> {
  const [settings, bundle, usage] = await Promise.all([
    loadHarnessSettings(root),
    loadAgentConfig(root),
    loadUsageSnapshots(root)
  ]);
  const resolvedExtensions = await resolveStepExtensions({ root, toolId: settings.defaultAgent });
  return routeWithPreferred(
    bundle,
    usage,
    settings.defaultAgent,
    "author",
    resolvedExtensions.enabledIds,
    resolvedExtensions.entries
  );
}

export async function formatStepNoRouteMessage(
  root: string,
  workflowId: string,
  stepId: string
): Promise<string> {
  const [workflow, bundle] = await Promise.all([loadWorkflow(root, workflowId), loadAgentConfig(root)]);
  return formatNoRouteMessage(bundle, roleCapability(workflow.steps[stepId]?.agent));
}

export function buildResolvedStageAgents(
  workflow: WorkflowDefinition,
  overrides: StageAgentOverrides,
  defaultAgent: ToolId
): ResolvedStageAgent[] {
  return Object.entries(workflow.steps).map(([stage, step]) => {
    const override = overrides.overrides[stage];
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
