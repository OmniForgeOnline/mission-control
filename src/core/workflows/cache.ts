import { copyFile, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { ensureDir } from "../infra/fs.ts";
import {
  BUNDLED_WORKFLOW_IDS,
  DEFAULT_WORKFLOW_ID,
  bundledWorkflowsDir,
  workflowsDir,
  type WorkflowDefinition
} from "./types.ts";
import { validateWorkflow } from "./validate.ts";

let cachedWorkflows: Map<string, WorkflowDefinition> | null = null;
let cachedRoot: string | null = null;

export function workflowFilePath(root: string, workflowId: string): string {
  return path.join(workflowsDir(root), `${workflowId}.yml`);
}

export async function ensureWorkflowFiles(root: string): Promise<void> {
  const targetDir = workflowsDir(root);
  await ensureDir(targetDir);
  await rm(path.join(targetDir, "ticket.yml"), { force: true });
  for (const id of BUNDLED_WORKFLOW_IDS) {
    const target = path.join(targetDir, `${id}.yml`);
    try {
      await readFile(target, "utf8");
    } catch {
      await copyFile(path.join(bundledWorkflowsDir(), `${id}.yml`), target);
    }
  }
}

/**
 * Overwrite the bundled workflow definitions in `root` with the current packaged
 * versions, picking up changes (e.g. new steps) that `ensureWorkflowFiles` skips
 * because the file already exists. Validates each bundled definition before writing
 * and leaves user-authored (non-bundled) workflows untouched. Returns the synced ids.
 */
export async function syncWorkflowFiles(root: string): Promise<string[]> {
  const targetDir = workflowsDir(root);
  await ensureDir(targetDir);
  const synced: string[] = [];
  for (const id of BUNDLED_WORKFLOW_IDS) {
    const source = path.join(bundledWorkflowsDir(), `${id}.yml`);
    const text = await readFile(source, "utf8");
    validateWorkflow(parseYaml(text));
    await copyFile(source, path.join(targetDir, `${id}.yml`));
    synced.push(id);
  }
  resetWorkflowCache();
  return synced;
}

export async function loadAllWorkflows(root: string): Promise<Map<string, WorkflowDefinition>> {
  if (cachedWorkflows && cachedRoot === root) return cachedWorkflows;
  await ensureWorkflowFiles(root);
  const dir = workflowsDir(root);
  const entries = await readdir(dir);
  const workflows = new Map<string, WorkflowDefinition>();
  for (const entry of entries) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    if (entry === "ticket.yml" || entry === "ticket.yaml") continue;
    const text = await readFile(path.join(dir, entry), "utf8");
    const workflow = validateWorkflow(parseYaml(text));
    if (workflow.id === "ticket") continue;
    workflows.set(workflow.id, workflow);
  }
  if (!workflows.has(DEFAULT_WORKFLOW_ID)) {
    throw new Error(`Default workflow "${DEFAULT_WORKFLOW_ID}" is missing.`);
  }
  cachedWorkflows = workflows;
  cachedRoot = root;
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

export function resetWorkflowCache(): void {
  cachedWorkflows = null;
  cachedRoot = null;
}