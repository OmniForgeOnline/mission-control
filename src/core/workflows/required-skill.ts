import { readSkill } from "../catalog/skills-catalog.ts";
import type { WorkflowStep } from "./types.ts";

/** Load the one skill bound to this step, or fail before the agent starts. */
export async function loadRequiredSkillSection(root: string, step: WorkflowStep): Promise<string> {
  if (!step.skill) return "";
  const { content } = await readSkill(root, step.skill);
  return `## Required skill: ${step.skill}\n\n${content}`;
}
