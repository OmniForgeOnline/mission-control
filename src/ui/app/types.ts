import type { HarnessSettings } from "../../core/settings.ts";
import type {
  ConnectorsState,
  ExecutionState,
  PmStatus,
  Resolution,
  TaskStatus
} from "../../core/types.ts";
import type { AgentConfigBundle } from "../../core/agents/config/types.ts";
import type { ExtensionRegistry } from "../../core/agents/extensions/types.ts";
import type { UsageSnapshots } from "../../core/agents/config/usage.ts";
import type { WorkflowMetadata } from "../../core/workflows/types.ts";

export interface WorkflowRun {
  workflowId: string;
  currentStepId: string;
  activeStepIds?: string[];
  completedSteps: string[];
  stepApprovals: Record<string, { stepId: string; status: string; approvedAt?: string }>;
  stepRuns?: Record<string, string[]>;
}

/** Stored attachment metadata. Embedded on tasks and messages for rendering. */
export interface HarnessAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  source: "intake" | "workflow" | "clickup";
  sourceUrl?: string;
  sourceKey?: string;
  createdAt: string;
}

export interface HarnessTask {
  id: string;
  title: string;
  description: string;
  agent: string;
  source: string;
  links: Array<{ label: string; url: string }>;
  targets: Array<{ raw: string; path: string; kind: string }>;
  messages: HarnessMessage[];
  attachments?: HarnessAttachment[];
  statusOverride?: { value: PmStatus; setAt: string };
  resolution?: Resolution;
  pausedAt?: string;
  interruptedAt?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  runId?: string;
  agentSessionId?: string;
  turnCount?: number;
  branch?: string;
  repoPath?: string;
  projectId?: string;
  workspacePath?: string;
  pushedAt?: string;
  commitCount?: number;
  mergeRequest?: {
    provider: "github" | "gitlab";
    url: string;
    number: number;
    mergedAt?: string;
    state?: "open" | "merged" | "closed";
    checkedAt?: string;
  };
  worktreeCleanedAt?: string;
  reviewState?: string;
  lastProgressAt?: string;
  currentActivity?: string;
  effort?: string;
  stageAgentOverrides?: Record<string, string>;
  stageEffortOverrides?: Record<string, string>;
  stageModelPoolOverrides?: Record<string, string>;
  workflowRun?: WorkflowRun;
  label?: "proposal";
  proposalChange?: { kind: string; targetPath: string; content: string };
}

export interface HarnessMessage {
  id: string;
  author: "operator" | "agent" | "system";
  body: string;
  createdAt: string;
  stepId?: string;
  attachments?: HarnessAttachment[];
}

export interface HarnessRun {
  id: string;
  taskId: string;
  taskTitle: string;
  agent: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  command?: string;
  exitCode?: number;
  blockedReason?: string;
  artifacts: string[];
  modelPoolId?: string;
  stepId?: string;
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
  defaults: { author: string; reviewer: string; effort?: string };
  gitPipeline?: {
    remediationStepId: string;
    postPushStepIds: string[];
  };
}

export interface AutonomyJob {
  id: string;
  title: string;
  description: string;
  schedule: string;
  status: string;
  runMode: string;
  approvalPolicy: string;
  lastRunAt?: string;
  lastSummary?: string;
  isRunning?: boolean;
  activeRunId?: string;
  scope: "harness" | "project";
  scopeId?: string;
  scopeLabel?: string;
}

export interface MemoryPage {
  id?: string;
  projectId?: string;
  slug?: string;
  path?: string;
  title: string;
  type?: string;
  sourceType?: string;
  tags?: string[];
  content?: string;
  snippet?: string;
  score?: number;
  updatedAt?: string;
}

export interface IntakeTicketDraft {
  ready: boolean;
  title: string;
  description: string;
  workflowId: string | null;
  confidence: "high" | "medium" | "low";
  rationale: string;
  suggestNewWorkflow?: {
    suggestedId: string;
    suggestedName: string;
    rationale: string;
    outline?: string;
  } | null;
}

export interface IntakeSession {
  id: string;
  agent: string;
  status: string;
  scope?: { kind: "global" } | { kind: "project"; projectId: string };
  messages: HarnessMessage[];
  queue?: Array<{
    id: string;
    messageId: string;
    status: "pending" | "running" | "completed" | "failed";
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    lastActivityAt?: string;
    activity?: string;
    taskId?: string;
    error?: string;
  }>;
  pendingDraft?: IntakeTicketDraft;
  createdTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  repoPath: string;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface QuickStart {
  label: string;
  prompt: string;
}

export interface QuickstartsFile {
  status: "default" | "generating" | "ready" | "failed";
  quickstarts: QuickStart[];
  generatedAt?: string;
  repoPath?: string;
  error?: string;
}

export type QualityGateStatus = "pending" | "generating" | "ready" | "incomplete" | "failed";

/** A single evidence-backed check in a generated quality-gate config. */
export interface QualityGateCheck {
  name: string;
  category: string;
  command: string;
  required: boolean;
  workingDirectory?: string;
  evidence?: string[];
}

/**
 * A project's generated quality-gate config. Mirrors the backend QualityGateFile
 * minus the heavy intel snapshot (not rendered). `status` drives the panel state
 * and the regenerate polling loop.
 */
export interface QualityGateFile {
  status: QualityGateStatus;
  checks: QualityGateCheck[];
  needsResolution?: string[];
  rationale?: string;
  generatedAt?: string;
  repoPath?: string;
  error?: string;
}

/** Outcome of a single quality-gate check run on demand (POST /quality-gate/run). */
export type CheckResultStatus = "passed" | "failed" | "skipped";

export interface CheckResult {
  name: string;
  command: string;
  status: CheckResultStatus;
  exitCode: number;
  output?: string;
  skipReason?: string;
}

/** Summary returned by running one or all gate checks. */
export interface CheckRunSummary {
  outcome: string;
  pass: boolean;
  skipped: boolean;
  results: CheckResult[];
}

export interface AgentSummary {
  id: string;
  displayName: string;
  supportsEffort: boolean;
  effortLevels: string[];
}

export interface AppState {
  root: string;
  /** Per-server token the UI echoes in x-shutdown-token to authorize shutdown. */
  shutdownToken?: string;
  settings?: HarnessSettings;
  agents?: AgentSummary[];
  agentConfig?: AgentConfigBundle;
  agentExtensions?: ExtensionRegistry;
  agentUsageSnapshots?: UsageSnapshots;
  connectors: ConnectorsState;
  tasks: HarnessTask[];
  runs: HarnessRun[];
  memoryPages: MemoryPage[];
  autonomyJobs: AutonomyJob[];
  projects?: ProjectSummary[];
  workflows?: WorkflowSummary[];
  workflow?: WorkflowMetadata;
  stageAgentOverrides?: Record<string, string>;
  inflightTaskIds?: string[];
  activityThresholds?: { staleMs: number; longRunMs: number };
  intakeSession?: IntakeSession;
  /** Desktop editors offered by the ticket "Open worktree" handoff. */
  editors?: EditorOption[];
}

/** Catalog entry for a desktop editor the operator can hand a worktree off to. */
export interface EditorOption {
  id: string;
  label: string;
}

/** @deprecated Derived at runtime — use task-status helpers instead. */
export type { TaskStatus, PmStatus, Resolution, ExecutionState };
