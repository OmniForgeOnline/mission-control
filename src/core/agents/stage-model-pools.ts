import path from "node:path";

import { readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import type { ModelPoolId } from "../types.ts";
import { assertValidWorkflowStep, loadWorkflow } from "../workflows/index.ts";
import { loadAllWorkflows, resolveStepAgent } from "../workflows/index.ts";
import { loadHarnessSettings } from "../settings.ts";
import { loadAgentConfig } from "./config/store.ts";
import { loadStageAgentOverrides, stageOverrideKey } from "./stage-agents.ts";

export interface StageModelPoolOverrides {
  overrides: Record<string, ModelPoolId>;
  ambiguousLegacy?: Record<string, ModelPoolId>;
}

function stageModelPoolsPath(root: string): string {
  return path.join(root, "data", "state", "stage-model-pools.json");
}

export function lookupStageModelPoolOverride(
  overrides: StageModelPoolOverrides,
  workflowId: string,
  stepId: string
): ModelPoolId | undefined {
  return overrides.overrides[stageOverrideKey(workflowId, stepId)];
}

export async function loadStageModelPoolOverrides(root: string): Promise<StageModelPoolOverrides> {
  await ensureHarnessRepository(root);
  const raw = await readJsonFile<StageModelPoolOverrides>(stageModelPoolsPath(root), { overrides: {} });
  const workflows = await loadAllWorkflows(root);
  const owners = new Map<string, string[]>();
  for (const [workflowId, workflow] of workflows) {
    for (const stepId of Object.keys(workflow.steps)) {
      owners.set(stepId, [...(owners.get(stepId) ?? []), workflowId]);
    }
  }
  let changed = false;
  const overrides = { ...raw.overrides };
  const ambiguousLegacy = { ...raw.ambiguousLegacy };
  for (const [stepId, poolId] of Object.entries(raw.overrides)) {
    if (stepId.includes(":")) continue;
    delete overrides[stepId];
    const workflowIds = owners.get(stepId) ?? [];
    if (workflowIds.length === 1) overrides[stageOverrideKey(workflowIds[0]!, stepId)] = poolId;
    else ambiguousLegacy[stepId] = poolId;
    changed = true;
  }
  const config: StageModelPoolOverrides = {
    overrides,
    ...(Object.keys(ambiguousLegacy).length ? { ambiguousLegacy } : {})
  };
  if (changed) await saveStageModelPoolOverrides(root, config);
  return config;
}

async function saveStageModelPoolOverrides(
  root: string,
  config: StageModelPoolOverrides
): Promise<void> {
  await writeJsonFile(stageModelPoolsPath(root), config);
}

export async function setStageModelPoolOverride(
  root: string,
  stage: string,
  poolId: ModelPoolId,
  workflowId = "code-feature"
): Promise<StageModelPoolOverrides> {
  const workflow = await loadWorkflow(root, workflowId);
  assertValidWorkflowStep(workflow, stage);
  const step = workflow.steps[stage]!;
  if (step.agent === "none") {
    throw new Error(`Step "${stage}" does not use an agent.`);
  }
  const [bundle, settings, stageAgents] = await Promise.all([
    loadAgentConfig(root),
    loadHarnessSettings(root),
    loadStageAgentOverrides(root)
  ]);
  const agent = resolveStepAgent(workflow, stageAgents, stage, settings.defaultAgent);
  const pool = bundle.pools.find((entry) => entry.id === poolId);
  if (!pool) throw new Error(`Model pool "${poolId}" is not registered. Choose a model from the dropdown.`);
  if (!pool.enabled) throw new Error(`Model pool "${poolId}" is disabled.`);
  if (agent && pool.toolId !== agent) {
    throw new Error(`Model pool "${poolId}" belongs to agent "${pool.toolId}", not "${agent}".`);
  }
  const capability = step.agent === "reviewer" || step.kind === "review" ? "reviewer" : "author";
  if (!pool.capabilities.includes(capability)) {
    throw new Error(`Model pool "${poolId}" does not advertise capability "${capability}".`);
  }
  const config = await loadStageModelPoolOverrides(root);
  config.overrides[stageOverrideKey(workflowId, stage)] = poolId;
  await saveStageModelPoolOverrides(root, config);
  return config;
}

export async function adoptAmbiguousLegacyModelPoolOverride(
  root: string,
  stepId: string,
  workflowId: string
): Promise<StageModelPoolOverrides> {
  const config = await loadStageModelPoolOverrides(root);
  const poolId = config.ambiguousLegacy?.[stepId];
  if (!poolId) throw new Error(`No ambiguous legacy model pool override for step "${stepId}".`);
  // Route adoption through the same enabled/tool/capability validation as a new write.
  await setStageModelPoolOverride(root, stepId, poolId, workflowId);
  const validated = await loadStageModelPoolOverrides(root);
  const next = { ...validated.ambiguousLegacy };
  delete next[stepId];
  if (Object.keys(next).length) validated.ambiguousLegacy = next;
  else delete validated.ambiguousLegacy;
  await saveStageModelPoolOverrides(root, validated);
  return validated;
}

export async function clearStageModelPoolOverride(
  root: string,
  stage: string,
  workflowId = "code-feature"
): Promise<StageModelPoolOverrides> {
  const workflow = await loadWorkflow(root, workflowId);
  assertValidWorkflowStep(workflow, stage);
  const config = await loadStageModelPoolOverrides(root);
  delete config.overrides[stageOverrideKey(workflowId, stage)];
  await saveStageModelPoolOverrides(root, config);
  return config;
}
