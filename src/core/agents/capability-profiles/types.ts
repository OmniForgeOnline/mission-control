/** Routing capabilities for workflow steps (distinct from CLI adapter capabilities). */
export const WORKFLOW_CAPABILITY_IDS = [
  "intake",
  "research",
  "reasoning-plan",
  "technical-investigation",
  "long-horizon-code",
  "frontend",
  "prose",
  "data-analysis",
  "code-review",
  "fact-check",
  "visual-qa",
  "incident"
] as const;

export type WorkflowCapability = (typeof WORKFLOW_CAPABILITY_IDS)[number];

export type CapabilityFeature = "vision" | "tool-use" | "large-context" | "custom-provider";

export interface WorkflowStepCapabilityRequirement {
  primary: WorkflowCapability;
  requiredFeatures?: CapabilityFeature[];
}
