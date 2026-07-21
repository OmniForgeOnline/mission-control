export type EvalTaskClass =
  | "small"
  | "medium"
  | "failure"
  | "synthetic"
  | "decomposition"
  | "acceptance-contract";

export type EvalRisk = "low" | "medium" | "high";

export type EvalProvenanceKind = "historical" | "synthetic";

export type ReviewDecision = "approved" | "changes_requested" | "comment";

export type ChecksOutcome = "validated" | "failed" | "noChecks";

export type DeterministicCheckKind =
  | "reviewer-verdict"
  | "checks-outcome"
  | "workflow-step"
  | "artifact-present";

export interface EvalDeterministicCheck {
  kind: DeterministicCheckKind;
  decision?: ReviewDecision;
  outcome?: ChecksOutcome;
  stepId?: string;
  pathPattern?: string;
}

export interface EvalRubricItem {
  id: string;
  criterion: string;
  weight?: number;
}

export interface EvalArtifact {
  kind: string;
  pathPattern?: string;
  requiredSections?: string[];
}

export interface EvalOutcome {
  artifact?: EvalArtifact;
  deterministicChecks?: EvalDeterministicCheck[];
  rubric?: EvalRubricItem[];
}

export interface EvalTarget {
  path: string;
  kind: "file" | "directory";
}

export interface EvalInputs {
  title: string;
  description: string;
  targets?: EvalTarget[];
  context?: Record<string, string>;
}

export interface EvalProvenance {
  kind: EvalProvenanceKind;
  source: string;
  notes?: string;
  redactions?: string[];
}

export interface EvalReplayFixtures {
  /** Inline reviewer reply or path relative to package root. */
  reviewerReply?: string;
  /** Workspace paths for artifact-present replay. */
  artifactPaths?: string[];
  /** Workspace root for checks-outcome replay (path relative to package root). */
  workspacePath?: string;
}

export interface EvalReplay {
  fixtures?: EvalReplayFixtures;
}

export interface EvalCase {
  schemaVersion: 1;
  id: string;
  workflowId: string;
  taskClass: EvalTaskClass;
  inputs: EvalInputs;
  permittedTools: string[];
  outcome: EvalOutcome;
  risk: EvalRisk;
  provenance: EvalProvenance;
  replay?: EvalReplay;
  integrationOnly?: boolean;
}

export interface EvalValidationSuccess {
  ok: true;
  case: EvalCase;
}

export interface EvalValidationFailure {
  ok: false;
  errors: string[];
}

export type EvalValidationResult = EvalValidationSuccess | EvalValidationFailure;

export interface LoadedEvalCase {
  path: string;
  case: EvalCase | null;
  errors: string[];
}

export interface EvalCorpus {
  version: string;
  root: string;
  cases: LoadedEvalCase[];
}
