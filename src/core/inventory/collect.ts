import path from "node:path";

import { readJsonFile } from "../infra/fs.ts";
import { normalizeBundle } from "../agents/config/normalize.ts";
import { emptyUsageSnapshots } from "../agents/config/usage.ts";
import type { AgentConfigBundle, ModelPoolConfig } from "../agents/config/types.ts";
import type { HarnessSettings } from "../settings.ts";
import { DEFAULT_HARNESS_SETTINGS, expandSettingsPath } from "../settings.ts";
import type { HarnessTask } from "../types.ts";
import type {
  InventoryAgentTool,
  InventoryModelPool,
  ToolModelOwnershipMismatch,
  WorkflowUsageSummary
} from "./types.ts";
import {
  collectReferencedSkills,
  inventoryWorkflows,
  type WorkflowInventory
} from "./workflows.ts";
import { inventorySkills, missingSkillPackaging } from "./skills.ts";
import { redactValue } from "./redact.ts";
import { listAllRuns } from "../tasks/runs.ts";

function agentConfigPath(root: string): string {
  return path.join(root, "data", "state", "agent-config.json");
}

function settingsPath(root: string): string {
  return path.join(root, "data", "state", "settings.json");
}

function stageAgentsPath(root: string): string {
  return path.join(root, "data", "state", "stage-agents.json");
}

function usageSnapshotsPath(root: string): string {
  return path.join(root, "data", "state", "usage-snapshots.json");
}

function tasksPath(root: string): string {
  return path.join(root, "data", "state", "tasks.json");
}

async function readAgentConfig(root: string): Promise<AgentConfigBundle | null> {
  const stored = await readJsonFile<Partial<AgentConfigBundle> | null>(agentConfigPath(root), null);
  if (!stored || !Array.isArray(stored.tools) || stored.tools.length === 0) return null;
  try {
    return normalizeBundle(stored);
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function poolModelArgs(pool: Pick<ModelPoolConfig, "modelArgs"> | { modelArgs?: unknown }): string[] {
  return stringArray("modelArgs" in pool ? pool.modelArgs : []);
}

function detectToolModelOwnershipMismatchesFromRaw(
  stored: Partial<AgentConfigBundle> | null
): ToolModelOwnershipMismatch[] {
  if (!stored || !Array.isArray(stored.tools) || !Array.isArray(stored.pools)) return [];
  const toolIds = new Set(
    stored.tools
      .map((tool) => (typeof tool?.id === "string" ? tool.id.trim() : ""))
      .filter(Boolean)
  );
  return stored.pools
    .map((pool) => ({
      poolId: typeof pool?.id === "string" ? pool.id.trim() : "",
      toolId: typeof pool?.toolId === "string" ? pool.toolId.trim() : "",
      modelArgs: poolModelArgs(pool ?? {})
    }))
    .filter((pool) => pool.poolId && pool.toolId && !toolIds.has(pool.toolId))
    .map((pool) => ({
      poolId: pool.poolId,
      toolId: pool.toolId,
      modelArgs: pool.modelArgs,
      reason: "missing-tool" as const
    }));
}

async function readSettings(root: string): Promise<HarnessSettings> {
  const stored = await readJsonFile<Partial<HarnessSettings> | null>(settingsPath(root), null);
  if (!stored) return { ...DEFAULT_HARNESS_SETTINGS };
  return {
    defaultAgent:
      typeof stored.defaultAgent === "string" && stored.defaultAgent.trim()
        ? stored.defaultAgent.trim()
        : DEFAULT_HARNESS_SETTINGS.defaultAgent,
    activityThresholds: DEFAULT_HARNESS_SETTINGS.activityThresholds,
    theme:
      stored.theme === "light" || stored.theme === "dark"
        ? stored.theme
        : DEFAULT_HARNESS_SETTINGS.theme,
    projectsRoot:
      typeof stored.projectsRoot === "string" && stored.projectsRoot.trim()
        ? expandSettingsPath(stored.projectsRoot)
        : DEFAULT_HARNESS_SETTINGS.projectsRoot
  };
}

function summarizeAgentTools(bundle: AgentConfigBundle | null): InventoryAgentTool[] {
  if (!bundle) return [];
  return bundle.tools.map((tool) => ({
    id: tool.id,
    displayName: tool.displayName,
    enabled: tool.enabled,
    adapter: tool.adapter,
    usageKind: tool.usage.kind
  }));
}

function summarizeModelPools(bundle: AgentConfigBundle | null): InventoryModelPool[] {
  if (!bundle) return [];
  return bundle.pools.map((pool) => ({
    id: pool.id,
    toolId: pool.toolId,
    enabled: pool.enabled,
    tier: pool.tier,
    modelArgs: [...pool.modelArgs],
    ...(pool.identity
      ? {
          provider: pool.identity.provider,
          configuredModel: pool.identity.configuredModel,
          verificationState: pool.identity.verificationState
        }
      : {})
  }));
}

function detectToolModelOwnershipMismatches(bundle: AgentConfigBundle | null): ToolModelOwnershipMismatch[] {
  if (!bundle) return [];
  const toolIds = new Set(bundle.tools.map((tool) => tool.id));
  return bundle.pools
    .filter((pool) => !toolIds.has(pool.toolId))
    .map((pool) => ({
      poolId: pool.id,
      toolId: pool.toolId,
      modelArgs: [...pool.modelArgs],
      reason: "missing-tool" as const
    }));
}

function collectUnknownAgentIds(
  registered: Set<string>,
  workflowInventory: WorkflowInventory
): string[] {
  return workflowInventory.runtimeAgentIds.filter((agentId) => !registered.has(agentId));
}

function detectUnknownModelIds(
  rawAgentConfig: Partial<AgentConfigBundle> | null,
  usageSnapshots: { snapshots: Array<{ modelPoolId?: string }> }
): string[] {
  const configuredPoolIds = new Set(
    (rawAgentConfig?.pools ?? [])
      .map((pool) => (typeof pool?.id === "string" ? pool.id.trim() : ""))
      .filter(Boolean)
  );
  const unknown = new Set<string>();
  for (const snapshot of usageSnapshots.snapshots) {
    const modelPoolId =
      typeof snapshot.modelPoolId === "string" ? snapshot.modelPoolId.trim() : "";
    if (modelPoolId && !configuredPoolIds.has(modelPoolId)) {
      unknown.add(modelPoolId);
    }
  }
  return [...unknown].sort();
}

function summarizeWorkflowUsage(tasks: HarnessTask[]): WorkflowUsageSummary[] {
  const byWorkflow = new Map<string, WorkflowUsageSummary>();
  for (const task of tasks) {
    const workflowId = task.workflowRun?.workflowId ?? "unknown";
    const current =
      byWorkflow.get(workflowId) ??
      ({
        workflowId,
        taskCount: 0,
        completedCount: 0,
        totalTurns: 0,
        totalReviewRounds: 0
      } satisfies WorkflowUsageSummary);
    current.taskCount += 1;
    if (task.resolution === "completed") current.completedCount += 1;
    current.totalTurns += task.turnCount ?? 0;
    current.totalReviewRounds += task.reviewRounds ?? 0;
    byWorkflow.set(workflowId, current);
  }
  return [...byWorkflow.values()].sort((a, b) => a.workflowId.localeCompare(b.workflowId));
}

export async function collectRuntimeInventory(root: string) {
  const workflowInventory = await inventoryWorkflows(root);
  const workflows = workflowInventory.workflows;
  const referencedSkills = collectReferencedSkills(workflows);
  const { skills, contradictorySkillBodies } = await inventorySkills(root, referencedSkills);
  const rawAgentConfig = await readJsonFile<Partial<AgentConfigBundle> | null>(agentConfigPath(root), null);
  const bundle = await readAgentConfig(root);
  const settings = await readSettings(root);
  const stageOverrides = await readJsonFile<{ overrides?: Record<string, string>; ambiguousLegacy?: Record<string, string> }>(
    stageAgentsPath(root),
    { overrides: {} }
  );
  const stageModelPoolOverrides = await readJsonFile<{
    overrides?: Record<string, string>;
    ambiguousLegacy?: Record<string, string>;
  }>(path.join(root, "data", "state", "stage-model-pools.json"), { overrides: {} });
  const usageSnapshots = await readJsonFile(usageSnapshotsPath(root), emptyUsageSnapshots());
  const tasks = await readJsonFile<HarnessTask[]>(tasksPath(root), []);
  const runs = await listAllRuns(root);

  const missingPackaging = missingSkillPackaging(referencedSkills, skills);
  const invalidSkillReferences = skills
    .filter((skill) => skill.status === "invalid-reference")
    .map((skill) => skill.id);
  const registeredAgents = new Set(bundle?.tools.map((tool) => tool.id) ?? []);
  const unknownAgentIds = collectUnknownAgentIds(registeredAgents, workflowInventory);
  const unknownModelIds = detectUnknownModelIds(rawAgentConfig, usageSnapshots);
  const toolModelOwnershipMismatches = [
    ...detectToolModelOwnershipMismatches(bundle),
    ...detectToolModelOwnershipMismatchesFromRaw(rawAgentConfig)
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.poolId === entry.poolId &&
          candidate.toolId === entry.toolId &&
          candidate.reason === entry.reason
      ) === index
  );

  const inventory = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    root,
    workflows,
    skills,
    agentTools: summarizeAgentTools(bundle),
    modelPools: summarizeModelPools(bundle),
    settings: {
      defaultAgent: settings.defaultAgent,
      theme: settings.theme,
      projectsRoot: settings.projectsRoot
    },
    stageOverrides: stageOverrides.overrides ?? {},
    stageModelPoolOverrides: stageModelPoolOverrides.overrides ?? {},
    ambiguousStageAgentOverrides: stageOverrides.ambiguousLegacy ?? {},
    ambiguousStageModelPoolOverrides: stageModelPoolOverrides.ambiguousLegacy ?? {},
    taskOverrides: tasks
      .filter((task) => task.stageAgentOverrides || task.stageModelPoolOverrides)
      .map((task) => ({
        taskId: task.id,
        workflowId: task.workflowRun?.workflowId ?? "unknown",
        ...(task.stageAgentOverrides ? { agent: task.stageAgentOverrides } : {}),
        ...(task.stageModelPoolOverrides ? { modelPool: task.stageModelPoolOverrides } : {})
      }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    effectiveRoutings: runs
      .map((run) => ({
        taskId: run.taskId,
        ...(run.stepId ? { stepId: run.stepId } : {}),
        agent: run.agent,
        ...(run.modelPoolId ? { modelPoolId: run.modelPoolId } : {})
      }))
      .sort((left, right) => `${left.taskId}:${left.stepId ?? ""}`.localeCompare(`${right.taskId}:${right.stepId ?? ""}`)),
    usageSnapshots: {
      refreshedAt: usageSnapshots.refreshedAt,
      snapshots: usageSnapshots.snapshots.map((snapshot) => ({
        toolId: snapshot.toolId,
        ...(snapshot.modelPoolId ? { modelPoolId: snapshot.modelPoolId } : {}),
        ...(snapshot.used !== undefined ? { used: snapshot.used } : {}),
        ...(snapshot.usedPercent !== undefined ? { usedPercent: snapshot.usedPercent } : {}),
        ...(snapshot.windowLabel ? { windowLabel: snapshot.windowLabel } : {}),
        ...(snapshot.source ? { source: snapshot.source } : {})
      }))
    },
    workflowUsage: summarizeWorkflowUsage(tasks),
    drift: {
      missingSkillPackaging: missingPackaging,
      contradictorySkillBodies,
      unknownAgentIds,
      unknownModelIds,
      toolModelOwnershipMismatches,
      invalidSkillReferences
    }
  };

  return redactValue(inventory);
}

export function stableInventorySnapshot<T extends { generatedAt?: string }>(
  inventory: T
): Omit<T, "generatedAt"> {
  const { generatedAt: _generatedAt, ...rest } = inventory;
  return rest;
}

export async function writeInventorySnapshot(
  inventory: Awaited<ReturnType<typeof collectRuntimeInventory>>,
  outPath: string
): Promise<void> {
  const { ensureDir } = await import("../infra/fs.ts");
  const { dirname } = await import("node:path");
  const { writeFile } = await import("node:fs/promises");
  await ensureDir(dirname(outPath));
  await writeFile(outPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}
