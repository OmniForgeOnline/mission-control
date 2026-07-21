import { inventorySkills, missingSkillPackaging } from "../inventory/skills.ts";
import type { WorkflowDefinition, WorkflowStep } from "./types.ts";

function referencedSkillIds(workflow: WorkflowDefinition): string[] {
  return [
    ...new Set(
      Object.values(workflow.steps)
        .map((step) => step.skill)
        .filter((skill): skill is string => Boolean(skill))
    )
  ].sort();
}

export async function findMissingWorkflowSkillReferences(
  root: string,
  workflow: WorkflowDefinition
): Promise<string[]> {
  const skillIds = referencedSkillIds(workflow);
  if (skillIds.length === 0) return [];
  const { skills } = await inventorySkills(root, skillIds);
  return missingSkillPackaging(skillIds, skills);
}

export async function assertWorkflowSkillReferences(
  root: string,
  workflow: WorkflowDefinition
): Promise<void> {
  const missing = await findMissingWorkflowSkillReferences(root, workflow);
  if (missing.length > 0) {
    throw new Error(
      `Workflow "${workflow.id}" references unknown skill(s): ${missing.join(", ")}`
    );
  }
}

export async function stepSkillReferenceError(
  root: string,
  step: WorkflowStep
): Promise<string | null> {
  if (!step.skill) return null;
  const { skills } = await inventorySkills(root, [step.skill]);
  const missing = missingSkillPackaging([step.skill], skills);
  if (missing.length === 0) return null;
  return `Workflow step "${step.id}" references unknown skill "${step.skill}".`;
}
