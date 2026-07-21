import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { migrateRuntimeAssets } from "../bootstrap/runtime-assets/index.ts";
import { ensureDir } from "../infra/fs.ts";
import { workflowsDir } from "./paths.ts";
import {
  DEFAULT_WORKFLOW_ID,
  type WorkflowDefinition
} from "./types.ts";
import { assertWorkflowSkillReferences } from "./skill-validation.ts";
import { validateWorkflow } from "./validate.ts";

const cachedWorkflowsByRoot = new Map<string, Map<string, WorkflowDefinition>>();

export function workflowFilePath(root: string, workflowId: string): string {
  return path.join(workflowsDir(root), `${workflowId}.yml`);
}

export async function ensureWorkflowFiles(root: string): Promise<void> {
  const targetDir = workflowsDir(root);
  await ensureDir(targetDir);
  await rm(path.join(targetDir, "ticket.yml"), { force: true });
  await migrateRuntimeAssets(root);
}

/**
 * Upgrade bundled workflow definitions in `root` when the runtime copy still
 * matches the last installed bundled hash. Customized workflows remain pending
 * review until an explicit reset. Returns the upgraded ids.
 */
export async function syncWorkflowFiles(root: string): Promise<string[]> {
  const result = await migrateRuntimeAssets(root);
  resetWorkflowCache();
  return result.upgraded.workflows;
}

export async function loadAllWorkflows(root: string): Promise<Map<string, WorkflowDefinition>> {
  const cached = cachedWorkflowsByRoot.get(root);
  if (cached) return cached;
  await ensureWorkflowFiles(root);
  const dir = workflowsDir(root);
  const entries = await readdir(dir);
  const workflows = new Map<string, WorkflowDefinition>();
  for (const entry of entries) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    if (entry === "ticket.yml" || entry === "ticket.yaml") continue;
    const text = await readFile(path.join(dir, entry), "utf8");
    const workflow = validateWorkflow(parseYaml(text));
    await assertWorkflowSkillReferences(root, workflow);
    if (workflow.id === "ticket") continue;
    workflows.set(workflow.id, workflow);
  }
  if (!workflows.has(DEFAULT_WORKFLOW_ID)) {
    throw new Error(`Default workflow "${DEFAULT_WORKFLOW_ID}" is missing.`);
  }
  cachedWorkflowsByRoot.set(root, workflows);
  return workflows;
}

export async function loadWorkflow(root: string, workflowId: string): Promise<WorkflowDefinition> {
  const workflows = await loadAllWorkflows(root);
  const workflow = workflows.get(workflowId);
  if (!workflow) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  return workflow;
}

export function resetWorkflowCache(root?: string): void {
  if (root) cachedWorkflowsByRoot.delete(root);
  else cachedWorkflowsByRoot.clear();
}
