import { hashBody } from "../inventory/hash.ts";
import { BASELINE_METRICS_VERSION, BASELINE_SCHEMA_VERSION } from "./types.ts";

export interface ModelIdentityFingerprint {
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
}

export interface BaselineIdInput {
  corpusVersion: string;
  caseIds: string[];
  workflowHashes: Record<string, string>;
  skillHashes?: Record<string, string>;
  modelIdentities: ModelIdentityFingerprint;
  caseFingerprints?: Record<string, string>;
  metricsVersion?: string;
}

/** Corpus + workflow + model-pool scoped; model pool changes yield a new baseline id. */
export function fingerprintModelIdentities(modelIdentities: ModelIdentityFingerprint) {
  return {
    defaultAgent: modelIdentities.defaultAgent,
    modelPools: [...modelIdentities.modelPools].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    stageOverrides: Object.fromEntries(
      Object.entries(modelIdentities.stageOverrides).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
    ...(modelIdentities.stageModelPoolOverrides
      ? {
          stageModelPoolOverrides: Object.fromEntries(
            Object.entries(modelIdentities.stageModelPoolOverrides).sort(([left], [right]) =>
              left.localeCompare(right)
            )
          )
        }
      : {})
  };
}

export function computeBaselineId(input: BaselineIdInput): string {
  const payload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    metricsVersion: input.metricsVersion ?? BASELINE_METRICS_VERSION,
    corpusVersion: input.corpusVersion,
    caseIds: [...input.caseIds].sort(),
    ...(input.caseFingerprints
      ? { caseFingerprints: Object.fromEntries(Object.entries(input.caseFingerprints).sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
    workflowHashes: Object.fromEntries(
      Object.entries(input.workflowHashes).sort(([left], [right]) => left.localeCompare(right))
    ),
    ...(input.skillHashes
      ? { skillHashes: Object.fromEntries(Object.entries(input.skillHashes).sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
    modelIdentities: fingerprintModelIdentities(input.modelIdentities)
  };
  return `baseline-${hashBody(JSON.stringify(payload)).slice(0, 16)}`;
}
