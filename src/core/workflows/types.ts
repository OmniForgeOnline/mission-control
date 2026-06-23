import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolId, EffortLevel } from "../types.ts";

export type WorkflowStepKind =
  | "conversation"
  | "agent_turn"
  | "create_merge_request"
  | "resolve_conflicts"
  | "review"
  | "terminal";
export type WorkflowStepApproval = "required" | "none";
export type WorkflowStepAgent = "none" | "author" | "reviewer" | ToolId;

export interface WorkflowAgentDefaults {
  author: ToolId;
  reviewer: ToolId;
  /** Fallback effort when a step does not declare its own. */
  effort?: EffortLevel;
}

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  agent: WorkflowStepAgent;
  skill?: string;
  approval: WorkflowStepApproval;
  /** When true, the harness prepares an isolated git worktree (and branch) for this step. */
  modifiesRepo?: boolean;
  /** Reasoning effort for agent turns on this step. */
  effort?: EffortLevel;
  /** Optional override for generated merge request title. */
  mergeRequestTitle?: string;
  /** Optional override for generated merge request description. */
  mergeRequestDescription?: string;
  next?: string;
  /** Fan-out: start these steps concurrently. */
  parallel?: string[];
  /** Fan-in target after parallel branches complete. */
  join?: string;
  joinPolicy?: "all" | "any";
  branch?: Record<string, string>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  initial: string;
  defaults: WorkflowAgentDefaults;
  steps: Record<string, WorkflowStep>;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  initial: string;
  stepIds: string[];
  steps: Record<
    string,
    {
      kind: string;
      agent: string;
      approval: string;
      skill?: string;
      effort?: string;
      next?: string;
      parallel?: string[];
      join?: string;
      branch?: Record<string, string>;
    }
  >;
  defaults: WorkflowAgentDefaults;
  gitPipeline?: {
    remediationStepId: string;
    postPushStepIds: string[];
  };
}

export interface WorkflowMetadata {
  id: string;
  name: string;
  initial: string;
  defaults: WorkflowAgentDefaults;
  steps: Record<
    string,
    {
      kind: string;
      agent: string;
      skill?: string;
      approval: string;
      effort?: string;
      next?: string;
      branch?: Record<string, string>;
    }
  >;
  stageAgents: Array<{
    stage: string;
    role: string;
    agent: string | null;
    source: string;
    override?: string;
  }>;
}

export const DEFAULT_WORKFLOW_ID = "code-feature";

export const VALID_KINDS = new Set<WorkflowStepKind>([
  "conversation",
  "agent_turn",
  "create_merge_request",
  "resolve_conflicts",
  "review",
  "terminal"
]);
export const VALID_APPROVALS = new Set<WorkflowStepApproval>(["required", "none"]);
export const VALID_EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);

const PACKAGE_ROOT =
  process.env["HARNESS_PACKAGE_ROOT"] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const BUNDLED_WORKFLOW_IDS = [
  "code-feature",
  "bugfix",
  "frontend-ui-change",
  "technical-debt",
  "product-spec",
  "ux-research",
  "write-document",
  "docs-update",
  "blog-post",
  "seo-investigation",
  "marketing-asset",
  "customer-support",
  "incident-response",
  "infrastructure-change",
  "data-analysis"
] as const;

export function bundledWorkflowsDir(): string {
  return path.join(PACKAGE_ROOT, "workflows");
}

export function workflowsDir(root: string): string {
  return path.join(root, "workflows");
}