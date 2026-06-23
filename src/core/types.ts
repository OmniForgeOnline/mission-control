/** Identity of a configurable CLI tool. Open set; validated against agent-config.json. */
export type ToolId = string;
/** Identity of a model pool bound to a tool. */
export type ModelPoolId = string;
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}
export type ConnectorSource = "manual" | "github" | "gitlab" | "clickup" | "intake" | "autonomy" | "agent";
export type ConnectorProviderId = "github" | "gitlab" | "clickup";
export type ConnectorConnectionStatus = "connected" | "error" | "disconnected";
export type TaskLabel = "proposal";

/** @deprecated Removed from persisted tasks — use PmStatus + ExecutionState + Resolution. */
export type TaskStatus =
  | "queued"
  | "approved"
  | "running"
  | "awaiting_operator"
  | "awaiting_review"
  | "pushed"
  | "completed"
  | "blocked"
  | "paused"
  | "interrupted"
  | "cancelled";

export type PmStatus = "backlog" | "in_progress" | "in_review" | "done";
export type Resolution = "completed" | "cancelled" | "superseded" | "wont_do";
export type ExecutionState = "idle" | "running" | "blocked" | "paused";

export type ReviewState = "approved" | "changes_requested" | "none";
export type RunStatus = "running" | "completed" | "blocked" | "paused" | "interrupted";
export type ProposalKind = "rule" | "memory" | "skill" | "hook";
export type ProposalStatus = "pending" | "approved" | "rejected";
export type WorkflowStepApprovalStatus = "pending" | "approved" | "skipped";

export interface WorkflowStepApprovalState {
  stepId: string;
  status: WorkflowStepApprovalStatus;
  approvedAt?: string;
}

export interface WorkflowRun {
  workflowId: string;
  currentStepId: string;
  /** Phase 2 parallel frontier — when set, takes precedence over currentStepId. */
  activeStepIds?: string[];
  completedSteps: string[];
  stepApprovals: Record<string, WorkflowStepApprovalState>;
  stepRuns?: Record<string, string[]>;
}

export interface HarnessLink {
  label: string;
  url: string;
}

/** Flow that produced an attachment. `clickup` is set by the sync importer; the
 * upload route accepts only operator-facing flows. */
export type AttachmentSource = "intake" | "workflow" | "clickup";

/** Immutable metadata for a stored attachment. Embedded inline on messages and
 * tasks for rendering; the authoritative blob + dedup index lives in the
 * attachment store (`core/attachments/store.ts`). */
export interface HarnessAttachment {
  id: string;
  /** User-facing, sanitized original filename. */
  filename: string;
  mimeType: string;
  /** Size in bytes of the stored blob. */
  size: number;
  source: AttachmentSource;
  /** Traceability URL for imported attachments (e.g. ClickUp attachment URL). */
  sourceUrl?: string;
  /** Stable dedup key for imported attachments (e.g. `clickup:<taskId>:<attachmentId>`). */
  sourceKey?: string;
  createdAt: string;
}

export interface ProposalChange {
  kind: ProposalKind;
  targetPath: string;
  content: string;
}

export interface HarnessTarget {
  raw: string;
  path: string;
  kind: "file" | "directory";
}

export interface HarnessMessage {
  id: string;
  author: "operator" | "agent" | "system";
  body: string;
  createdAt: string;
  /** Workflow step this message is scoped to (step-panel chat). */
  stepId?: string;
  /** Attachments the operator added with this message (step-panel replies). */
  attachments?: HarnessAttachment[];
}

export interface HarnessTask {
  id: string;
  title: string;
  description: string;
  agent: ToolId;
  source: ConnectorSource;
  links: HarnessLink[];
  targets: HarnessTarget[];
  messages: HarnessMessage[];
  /** Ticket-level attachments (intake uploads and imported ClickUp attachments). */
  attachments?: HarnessAttachment[];
  /** Operator override for PM status; cleared when workflow outranks it. */
  statusOverride?: { value: PmStatus; setAt: string };
  /** Set when the ticket is manually or workflow-completed done. */
  resolution?: Resolution;
  /** Execution paused by operator or abort. */
  pausedAt?: string;
  /** Turn interrupted but resumable. */
  interruptedAt?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  runId?: string;
  /** Per-agent session id used to resume the conversation across turns. */
  agentSessionId?: string;
  /** Agent that created `agentSessionId`. Sessions are not shared across agents. */
  agentSessionAgent?: ToolId;
  /** Model pool that created `agentSessionId`. Sessions are not shared across model pools. */
  agentSessionModelPool?: ModelPoolId;
  /** Whether `agentSessionId` was created in plan/conversation mode. */
  agentSessionConversation?: boolean;
  /** Hash of stable instructions used when `agentSessionId` was created. */
  agentSessionStableHash?: string;
  /** Number of headless turns executed so far. */
  turnCount?: number;
  /** Resolved git repo path the harness worktrees off (when the destination is a repo). */
  repoPath?: string;
  /** Explicit onboarded project this ticket belongs to. Missing only for legacy tickets. */
  projectId?: string;
  /** Branch the harness uses for this task's worktree. */
  branch?: string;
  /** Path of the worktree the agent is running in. */
  workspacePath?: string;
  /** ISO timestamp the agent last pushed commits to origin. */
  pushedAt?: string;
  /** Number of commits ahead of the destination repo's base branch. */
  commitCount?: number;
  /** Number of follow-up turns scheduled to fix mechanical-check failures. */
  checkRound?: number;
  /** Number of follow-up turns scheduled to resolve merge conflicts against the base branch. */
  conflictRound?: number;
  /** Last accumulated mechanical-check failure summary. */
  lastCheckFailure?: string;
  /** Consecutive remediation attempts with the same failure fingerprint. */
  remediationStreak?: number;
  /** Fingerprint of the last remediation failure (commit/check). */
  lastRemediationFingerprint?: string;
  /** Number of reviewer→author round trips so far. */
  reviewRounds?: number;
  /** Latest reviewer verdict. */
  reviewState?: ReviewState;
  /** Open merge request / pull request created by the harness after push. */
  mergeRequest?: {
    provider: "github" | "gitlab";
    url: string;
    number: number;
    /** ISO timestamp when the host reported the MR/PR as merged. */
    mergedAt?: string;
    /** Last known external state of the MR/PR, refreshed by the merge-status sweep. */
    state?: "open" | "merged" | "closed";
    /** ISO timestamp of the last merge-state refresh against the forge. */
    checkedAt?: string;
  };
  /** ISO timestamp when the harness removed this task's isolated worktree. */
  worktreeCleanedAt?: string;
  /** Heartbeat for the in-flight turn (UI uses it for "active Ns ago"). */
  lastProgressAt?: string;
  /** Short description of the agent's most recent action during the live turn. */
  currentActivity?: string;
  /** Per-task effort level passed to the agent CLI. */
  effort?: EffortLevel;
  /** Per-task overrides for workflow step agents (highest priority). */
  stageAgentOverrides?: Partial<Record<string, ToolId>>;
  /** Per-task per-step effort overrides (outrank task-level effort). */
  stageEffortOverrides?: Partial<Record<string, EffortLevel>>;
  /** Number of manual resume attempts for the current step (capped to avoid infinite loops). */
  resumeAttempts?: number;
  /** Workflow step id the resumeAttempts counter applies to. The cap is per-step, so the
   * counter resets whenever the workflow advances to a different step. */
  resumeAttemptsStepId?: string;
  /** Workflow execution state (separate from operational lifecycle status). */
  workflowRun?: WorkflowRun;
  /** @deprecated Legacy only — normalized away on load; propose_* tickets use description markers. */
  label?: TaskLabel;
  /** @deprecated Legacy only — normalized away on load; content lives in description. */
  proposalChange?: ProposalChange;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  /** Workflow type to run (defaults to code-feature). */
  workflowId?: string;
  /** Optional legacy hint; step defaults determine which agent runs. */
  agent?: ToolId;
  source: ConnectorSource;
  links?: HarnessLink[];
  targets?: HarnessTarget[];
  projectId?: string;
  repoPath?: string;
  effort?: EffortLevel;
  /** Resolved attachment ids to embed on the created ticket. */
  attachmentIds?: string[];
}

export interface HarnessRun {
  id: string;
  taskId: string;
  taskTitle: string;
  /** Onboarded project this run belongs to. Absent for project-less daemon-maintenance runs. */
  projectId?: string;
  agent: ToolId;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  command?: string;
  exitCode?: number;
  blockedReason?: string;
  artifacts: string[];
  /** Resolved model pool that drove this agent turn. Absent on historical runs. */
  modelPoolId?: ModelPoolId;
  /** Workflow step this turn executed. Absent on historical and non-step (autonomy) runs. */
  stepId?: string;
}

export interface HarnessProposal {
  id: string;
  kind: ProposalKind;
  title: string;
  rationale: string;
  targetPath: string;
  content: string;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
}

export interface CreateProposalInput {
  kind: ProposalKind;
  title: string;
  rationale: string;
  targetPath: string;
  content: string;
  /** Workflow to run (defaults to the harness default, same as createTask). */
  workflowId?: string;
  /** Required for `kind: "memory"` — the project the memory page belongs to. */
  projectId?: string;
}

export interface GithubConnectionConfig {
  owner?: string;
  repo?: string;
}

export interface GitlabConnectionConfig {
  projectId?: string;
}

export interface ClickUpConnectionConfig {
  teamId?: string;
  listId?: string;
  subscribedListIds?: string[];
  listProjectBindings?: Record<string, string>;
  cachedResources?: ConnectorResourceOption[];
  resourcesSyncedAt?: string;
}

export interface ConnectorConnectionConfig {
  github?: GithubConnectionConfig;
  gitlab?: GitlabConnectionConfig;
  clickup?: ClickUpConnectionConfig;
}

export type ConnectorAuthMethod = "token" | "gh_cli";

export interface ConnectorConnection {
  id: string;
  providerId: ConnectorProviderId;
  status: ConnectorConnectionStatus;
  authMethod: ConnectorAuthMethod;
  accountLabel?: string;
  scopes?: string[];
  connectedAt: string;
  lastError?: string;
  config: ConnectorConnectionConfig;
}

export interface ConnectorTokenPayload {
  accessToken: string;
  tokenType?: string;
}

export interface ConnectorProviderDef {
  id: ConnectorProviderId;
  displayName: string;
  tokenHint: string;
  tokenHelpUrl?: string;
}

export interface ConnectorProviderStatus extends ConnectorProviderDef {
  ghCliAvailable?: boolean;
}

export interface ConnectorResourceOption {
  id: string;
  label: string;
  meta?: Record<string, string>;
}

export interface ConnectorsState {
  providers: ConnectorProviderStatus[];
  connections: ConnectorConnection[];
}

export type IntakeConfidence = "high" | "medium" | "low";

export interface IntakeWorkflowSuggestion {
  suggestedId: string;
  suggestedName: string;
  rationale: string;
  outline?: string;
}

/** Parsed from the intake agent reply; not persisted once a ticket is created. */
export interface IntakeTicketDraft {
  ready: boolean;
  title: string;
  description: string;
  workflowId: string | null;
  confidence: IntakeConfidence;
  rationale: string;
  suggestNewWorkflow?: IntakeWorkflowSuggestion | null;
}

export type IntakeSessionStatus = "active" | "task_created" | "archived";

export type IntakeScope =
  | { kind: "global" }
  | { kind: "project"; projectId: string };

export type IntakeQueueStatus = "pending" | "running" | "completed" | "failed";

export interface IntakeQueueItem {
  id: string;
  messageId: string;
  status: IntakeQueueStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt?: string;
  activity?: string;
  taskId?: string;
  /** Attachment ids the operator uploaded with this intake message; carried to the task. */
  attachmentIds?: string[];
  error?: string;
}

export interface IntakeSession {
  id: string;
  agent: ToolId;
  status: IntakeSessionStatus;
  scope: IntakeScope;
  messages: HarnessMessage[];
  queue?: IntakeQueueItem[];
  /** Ready ticket draft awaiting operator confirmation. */
  pendingDraft?: IntakeTicketDraft;
  createdTaskId?: string;
  agentSessionId?: string;
  createdAt: string;
  updatedAt: string;
}
