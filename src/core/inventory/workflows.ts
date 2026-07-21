import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { bundledWorkflowsDir, workflowsDir } from "../workflows/paths.ts";
import {
  BUNDLED_WORKFLOW_IDS,
  type WorkflowDefinition
} from "../workflows/types.ts";
import { validateWorkflow } from "../workflows/validate.ts";
import type { AssetStatus, WorkflowAsset } from "./types.ts";

function canonicalWorkflowText(definition: WorkflowDefinition): string {
  return stringifyYaml(definition, { sortMapEntries: true }).trim();
}

async function readWorkflowFile(filePath: string): Promise<WorkflowDefinition | null> {
  try {
    const text = await readFile(filePath, "utf8");
    return validateWorkflow(parseYaml(text));
  } catch {
    return null;
  }
}

async function readBundledWorkflow(id: string): Promise<WorkflowDefinition | null> {
  return readWorkflowFile(path.join(bundledWorkflowsDir(), `${id}.yml`));
}

async function readRuntimeWorkflowEntries(root: string): Promise<Map<string, string>> {
  const dir = workflowsDir(root);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const byId = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const id = entry.replace(/\.ya?ml$/, "");
    if (id === "ticket") continue;
    byId.set(id, entry);
  }
  return byId;
}

function referencedSkills(definition: WorkflowDefinition): string[] {
  const skills = new Set<string>();
  for (const step of Object.values(definition.steps)) {
    if (step.skill) skills.add(step.skill);
  }
  return [...skills].sort();
}

function classifyWorkflow(
  bundled: WorkflowDefinition | null,
  runtime: WorkflowDefinition | null
): AssetStatus {
  if (bundled && runtime) {
    return canonicalWorkflowText(bundled) === canonicalWorkflowText(runtime)
      ? "unchanged"
      : "runtime-customized";
  }
  if (bundled && !runtime) return "bundled-only";
  if (!bundled && runtime) return "runtime-only";
  return "invalid-reference";
}

function collectAgentIdsFromRawWorkflow(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const record = doc as Record<string, unknown>;
  const agentIds = new Set<string>();

  const addAgentId = (value: unknown) => {
    if (typeof value !== "string") return;
    const agentId = value.trim();
    if (!agentId || agentId === "none" || agentId === "author" || agentId === "reviewer") return;
    agentIds.add(agentId);
  };

  const defaults =
    record["defaults"] && typeof record["defaults"] === "object"
      ? (record["defaults"] as Record<string, unknown>)
      : null;
  if (defaults) {
    const agents =
      defaults["agents"] && typeof defaults["agents"] === "object"
        ? (defaults["agents"] as Record<string, unknown>)
        : defaults;
    for (const agentId of Object.values(agents)) {
      addAgentId(agentId);
    }
  }

  const steps =
    record["steps"] && typeof record["steps"] === "object"
      ? (record["steps"] as Record<string, unknown>)
      : null;
  if (steps) {
    for (const stepValue of Object.values(steps)) {
      if (!stepValue || typeof stepValue !== "object") continue;
      addAgentId((stepValue as Record<string, unknown>)["agent"]);
    }
  }

  return [...agentIds];
}

export interface WorkflowInventory {
  workflows: WorkflowAsset[];
  runtimeDefinitions: Map<string, WorkflowDefinition>;
  runtimeAgentIds: string[];
}

export async function inventoryWorkflows(root: string): Promise<WorkflowInventory> {
  const runtimeEntries = await readRuntimeWorkflowEntries(root);
  const runtimeIds = [...runtimeEntries.keys()].sort();
  const bundledIds = [...BUNDLED_WORKFLOW_IDS];
  const bundledSet = new Set<string>(bundledIds);
  const allIds = [...new Set([...bundledIds, ...runtimeIds])].sort();
  const runtimeDefinitions = new Map<string, WorkflowDefinition>();
  const runtimeAgentIds = new Set<string>();

  const workflows: WorkflowAsset[] = [];
  for (const id of allIds) {
    const bundled = bundledSet.has(id) ? await readBundledWorkflow(id) : null;
    const runtimeEntry = runtimeEntries.get(id);
    let runtime: WorkflowDefinition | null = null;
    if (runtimeEntry) {
      const runtimePath = path.join(workflowsDir(root), runtimeEntry);
      try {
        const text = await readFile(runtimePath, "utf8");
        for (const agentId of collectAgentIdsFromRawWorkflow(parseYaml(text))) {
          runtimeAgentIds.add(agentId);
        }
        runtime = await readWorkflowFile(runtimePath);
      } catch {
        runtime = null;
      }
    }
    if (runtime) runtimeDefinitions.set(id, runtime);
    const definition = runtime ?? bundled;
    workflows.push({
      id,
      status: classifyWorkflow(bundled, runtime),
      bundled: bundled !== null,
      runtime: runtime !== null,
      referencedSkills: definition ? referencedSkills(definition) : []
    });
  }
  return { workflows, runtimeDefinitions, runtimeAgentIds: [...runtimeAgentIds].sort() };
}

export function collectReferencedSkills(workflows: WorkflowAsset[]): string[] {
  const skills = new Set<string>();
  for (const workflow of workflows) {
    for (const skill of workflow.referencedSkills) {
      skills.add(skill);
    }
  }
  return [...skills].sort();
}
