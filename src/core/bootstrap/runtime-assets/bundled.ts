import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DEFAULT_SKILLS } from "../defaults/skills.ts";
import { hashBody } from "../../inventory/hash.ts";
import { bundledSkillsDir } from "../../inventory/paths.ts";
import { bundledWorkflowsDir } from "../../workflows/paths.ts";
import {
  BUNDLED_WORKFLOW_IDS,
  type WorkflowDefinition
} from "../../workflows/types.ts";
import { validateWorkflow } from "../../workflows/validate.ts";

export function workflowCanonicalText(definition: WorkflowDefinition): string {
  return stringifyYaml(definition, { sortMapEntries: true }).trim();
}

export async function workflowBundledHash(text: string): Promise<string> {
  const definition = validateWorkflow(parseYaml(text));
  return hashBody(workflowCanonicalText(definition));
}

export async function readBundledWorkflowText(workflowId: string): Promise<string> {
  return readFile(path.join(bundledWorkflowsDir(), `${workflowId}.yml`), "utf8");
}

export async function readBundledWorkflowHash(workflowId: string): Promise<string> {
  return workflowBundledHash(await readBundledWorkflowText(workflowId));
}

const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function bundledSkillIds(): string[] {
  const ids = new Set<string>();
  for (const fileName of Object.keys(DEFAULT_SKILLS)) {
    const skillId = fileName.split("/")[0];
    if (skillId) ids.add(skillId);
  }
  try {
    for (const name of readdirSync(bundledSkillsDir())) {
      if (SKILL_ID_PATTERN.test(name)) ids.add(name);
    }
  } catch {
    /* packaged skills dir may be unavailable in isolated test contexts */
  }
  return [...ids].sort();
}

export async function readBundledSkillBody(skillId: string): Promise<string | null> {
  const seeded = DEFAULT_SKILLS[`${skillId}/SKILL.md`];
  if (seeded) return seeded;

  const packagedPath = path.join(bundledSkillsDir(), skillId, "SKILL.md");
  try {
    return await readFile(packagedPath, "utf8");
  } catch {
    return null;
  }
}

export function bundledSkillHash(body: string): string {
  return hashBody(body);
}

export async function readBundledSkillHash(skillId: string): Promise<string | null> {
  const body = await readBundledSkillBody(skillId);
  return body ? bundledSkillHash(body) : null;
}

export function listBundledWorkflowIds(): readonly string[] {
  return BUNDLED_WORKFLOW_IDS;
}
