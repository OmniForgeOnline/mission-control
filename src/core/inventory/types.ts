export type AssetStatus =
  | "unchanged"
  | "runtime-customized"
  | "runtime-only"
  | "bundled-only"
  | "invalid-reference";

export interface WorkflowAsset {
  id: string;
  status: AssetStatus;
  bundled: boolean;
  runtime: boolean;
  referencedSkills: string[];
}

export interface SkillAsset {
  id: string;
  status: AssetStatus;
  packaged: boolean;
  seeded: boolean;
  runtime: boolean;
  bodyHash?: string;
}

export interface SkillBodySource {
  source: "packaged" | "seeded" | "runtime";
  bodyHash: string;
}

export interface ToolModelOwnershipMismatch {
  poolId: string;
  toolId: string;
  modelArgs: string[];
  reason: "missing-tool" | "unknown-model";
}

export interface WorkflowUsageSummary {
  workflowId: string;
  taskCount: number;
  completedCount: number;
  totalTurns: number;
  totalReviewRounds: number;
}

export interface InventoryAgentTool {
  id: string;
  displayName: string;
  enabled: boolean;
  adapter: string;
  usageKind: string;
}

export interface InventoryModelPool {
  id: string;
  toolId: string;
  enabled: boolean;
  tier: string;
  /** CLI model selection args (e.g. `--model`, model id). No env secret values. */
  modelArgs: string[];
  provider?: string;
  configuredModel?: string;
  verificationState?: string;
}

export interface RuntimeInventory {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  workflows: WorkflowAsset[];
  skills: SkillAsset[];
  agentTools: InventoryAgentTool[];
  modelPools: InventoryModelPool[];
  settings: {
    defaultAgent: string;
    theme: string;
    projectsRoot: string;
  };
  stageOverrides: Record<string, string>;
  stageModelPoolOverrides: Record<string, string>;
  ambiguousStageAgentOverrides: Record<string, string>;
  ambiguousStageModelPoolOverrides: Record<string, string>;
  taskOverrides: Array<{
    taskId: string;
    workflowId: string;
    agent?: Partial<Record<string, string>>;
    modelPool?: Partial<Record<string, string>>;
  }>;
  effectiveRoutings: Array<{
    taskId: string;
    stepId?: string;
    agent: string;
    modelPoolId?: string;
  }>;
  usageSnapshots: {
    refreshedAt?: string;
    snapshots: Array<{
      toolId: string;
      modelPoolId?: string;
      used?: number;
      usedPercent?: number;
      windowLabel?: string;
      source?: string;
    }>;
  };
  workflowUsage: WorkflowUsageSummary[];
  drift: {
    missingSkillPackaging: string[];
    contradictorySkillBodies: Array<{
      skill: string;
      sources: SkillBodySource[];
    }>;
    unknownAgentIds: string[];
    unknownModelIds: string[];
    toolModelOwnershipMismatches: ToolModelOwnershipMismatch[];
    invalidSkillReferences: string[];
  };
}
