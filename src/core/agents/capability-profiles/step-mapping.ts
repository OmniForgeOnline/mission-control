import type { ReviewProfileId, WorkflowStep } from "../../workflows/types.ts";
import type { WorkflowCapability, WorkflowStepCapabilityRequirement } from "./types.ts";

const AUTHOR_WORKFLOW_CAPABILITIES: Record<string, WorkflowCapability> = {
  "blog-post": "prose",
  "write-document": "prose",
  "marketing-asset": "prose",
  "docs-update": "prose",
  "data-analysis": "data-analysis",
  "frontend-ui-change": "frontend",
  "incident-response": "incident",
  "seo-investigation": "research",
  "ux-research": "research",
  "product-spec": "reasoning-plan",
  "customer-support": "intake"
};

const CODE_WORKFLOWS = new Set([
  "code-feature",
  "bugfix",
  "technical-debt",
  "infrastructure-change"
]);

function reviewCapability(profile?: ReviewProfileId): WorkflowCapability {
  switch (profile) {
    case "frontend":
      return "visual-qa";
    case "content":
    case "technical-doc":
      return "fact-check";
    case "data":
      return "data-analysis";
    case "incident":
      return "incident";
    case "support":
      return "intake";
    case "decision":
      return "reasoning-plan";
    default:
      return "code-review";
  }
}

function requiredFeaturesFor(
  capability: WorkflowCapability,
  step: WorkflowStep
): WorkflowStepCapabilityRequirement["requiredFeatures"] {
  const features: NonNullable<WorkflowStepCapabilityRequirement["requiredFeatures"]> = [];
  if (capability === "visual-qa" || step.reviewProfile === "frontend") {
    features.push("vision");
  }
  if (
    capability === "technical-investigation" ||
    capability === "long-horizon-code" ||
    capability === "frontend" ||
    capability === "data-analysis"
  ) {
    features.push("tool-use");
  }
  if (
    capability === "technical-investigation" ||
    capability === "long-horizon-code" ||
    capability === "code-review" ||
    capability === "incident"
  ) {
    features.push("large-context");
  }
  if (step.agent && step.agent !== "none" && step.agent !== "author" && step.agent !== "reviewer") {
    features.push("custom-provider");
  }
  return features.length ? features : undefined;
}

function authorCapability(workflowId: string, step: WorkflowStep): WorkflowCapability {
  if (step.modifiesRepo === false) return "technical-investigation";
  const mapped = AUTHOR_WORKFLOW_CAPABILITIES[workflowId];
  if (mapped) return mapped;
  if (CODE_WORKFLOWS.has(workflowId) || workflowId === "docs-update") return "long-horizon-code";
  return "long-horizon-code";
}

function conversationCapability(workflowId: string): WorkflowCapability {
  return AUTHOR_WORKFLOW_CAPABILITIES[workflowId] === "intake" ? "intake" : "reasoning-plan";
}

export function capabilityForWorkflowStep(
  workflowId: string,
  step: WorkflowStep
): WorkflowStepCapabilityRequirement {
  switch (step.kind) {
    case "conversation":
      return { primary: conversationCapability(workflowId) };
    case "review": {
      const primary = reviewCapability(step.reviewProfile);
      const requiredFeatures = requiredFeaturesFor(primary, step);
      return { primary, ...(requiredFeatures ? { requiredFeatures } : {}) };
    }
    case "agent_turn": {
      const primary = authorCapability(workflowId, step);
      const requiredFeatures = requiredFeaturesFor(primary, step);
      return { primary, ...(requiredFeatures ? { requiredFeatures } : {}) };
    }
    case "create_merge_request":
    case "resolve_conflicts":
      return { primary: "long-horizon-code" };
    case "terminal":
      return { primary: "intake" };
    default:
      return { primary: "intake" };
  }
}
