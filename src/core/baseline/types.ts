import type { EvalCorpus, EvalProvenanceKind, EvalRisk, EvalTaskClass } from "../evals/types.ts";
import type { RuntimeInventory } from "../inventory/types.ts";
import type { HarnessTask } from "../types.ts";

export const BASELINE_SCHEMA_VERSION = 1 as const;
export const BASELINE_METRICS_VERSION = "1" as const;

export type UnknownMetric = "unknown";

export interface TaskUsageMetrics {
  inputTokens: UnknownMetric;
  outputTokens: UnknownMetric;
  costUsd: UnknownMetric;
}

export interface TaskMetricsAggregate {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  retried: number;
  reviewed: number;
  acceptedOutcome: number;
  deterministicPass: number;
  firstPassReviewAccepted: number;
  withCompletedAtButNotSuccessful: number;
  rates: {
    acceptedOutcome: number | null;
    deterministicPass: number | null;
    firstPassReviewAccepted: number | null;
  };
  averages: {
    reviewRounds: number;
    operatorInterventions: number;
    toolRetries: number;
    wallTimeMs: number | null;
  };
  usage: TaskUsageMetrics;
}

export interface HistoricalCaseObservation {
  caseId: string;
  workflowId: string;
  taskClass: EvalTaskClass;
  risk: EvalRisk;
  provenanceKind: EvalProvenanceKind;
  source: string;
  contextHints: Record<string, string>;
  deterministicCheckCount: number;
  rubricItemCount: number;
}

export interface HistoricalObservationSummary {
  caseCount: number;
  byWorkflow: Record<string, number>;
  byRisk: Record<EvalRisk, number>;
  cases: HistoricalCaseObservation[];
}

export type ReplayCheckStatus = "passed" | "failed" | "unsupported";

export interface ReplayCheckResult {
  kind: string;
  status: ReplayCheckStatus;
  message?: string;
}

export interface EvalCaseReplayResult {
  caseId: string;
  workflowId: string;
  provenanceKind: EvalProvenanceKind;
  structuralChecks: {
    total: number;
    passed: number;
    failed: number;
    unsupported: number;
  };
  checks: ReplayCheckResult[];
  passed: boolean;
  errors: string[];
  runtime?: {
    terminal: boolean;
    attempts: number;
    routingChoices: Array<{ stepId?: string; agent: string; modelPoolId?: string; effort?: string }>;
    artifacts: string[];
    reviewerVerdict: string;
    reviewerDecisions: string[];
  };
}

export interface CorpusReplaySummary {
  caseCount: number;
  passed: number;
  failed: number;
  unsupportedChecks: number;
  results: EvalCaseReplayResult[];
}

export interface CorpusReplayReport {
  historicalObservations: HistoricalObservationSummary;
  freshReplay: CorpusReplaySummary;
}

export interface QualityFloor {
  minAcceptedOutcomeRate: number;
  minDeterministicPassRate: number;
  minFirstPassReviewRate: number;
}

export interface QualityFloorEntry {
  capability: string;
  risk: EvalRisk;
  floor: QualityFloor;
  provisional: true;
}

export interface BaselineEnvironment {
  nodeVersion: string;
  platform: string;
  command: string;
  packageName: string | null;
  packageVersion: string | null;
}

export interface BaselineUsageSummary {
  inputTokens: UnknownMetric;
  outputTokens: UnknownMetric;
  costUsd: UnknownMetric;
  quotaSnapshots: RuntimeInventory["usageSnapshots"];
}

export interface BaselineReport {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  metricsVersion: typeof BASELINE_METRICS_VERSION;
  baselineId: string;
  generatedAt: string;
  environment: BaselineEnvironment;
  corpusVersion: string;
  workflowHashes: Record<string, string>;
  skillHashes: Record<string, string>;
  modelIdentities: {
    defaultAgent: string;
    modelPools: Array<{
      id: string;
      toolId: string;
      tier: string;
      enabled: boolean;
      modelArgs: string[];
    }>;
    stageOverrides: Record<string, string>;
    stageModelPoolOverrides?: Record<string, string>;
  };
  runtimeTaskMetrics: TaskMetricsAggregate;
  corpusReplay: CorpusReplayReport;
  usage: BaselineUsageSummary;
  qualityFloors: QualityFloorEntry[];
  phase2UnsupportedMetrics: readonly string[];
  spotCheck?: SpotCheckReport;
  historicalSpotCheck?: SpotCheckReport;
}

export type SpotCheckFieldStatus = "match" | "mismatch" | "fixture-only" | "no-runtime-task";

export interface SpotCheckFieldComparison {
  field: string;
  fixtureValue: string;
  runtimeValue?: string;
  status: SpotCheckFieldStatus;
  note?: string;
}

export interface SpotCheckReport {
  caseId: string;
  fixturePath: string;
  runtimeTaskFound: boolean;
  matchingRuntimeTaskId?: string;
  fieldsCompared: SpotCheckFieldComparison[];
  notes: string;
}

export interface BuildBaselineReportInput {
  root: string;
  inventory: RuntimeInventory;
  corpus: EvalCorpus;
  command?: string;
  tasks?: HarnessTask[];
}
