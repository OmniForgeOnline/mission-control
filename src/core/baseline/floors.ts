import type { EvalRisk } from "../evals/types.ts";
import type { QualityFloor, QualityFloorEntry } from "./types.ts";

const DEFAULT_FLOORS: Record<EvalRisk, QualityFloor> = {
  low: {
    minAcceptedOutcomeRate: 0.9,
    minDeterministicPassRate: 0.85,
    minFirstPassReviewRate: 0.75
  },
  medium: {
    minAcceptedOutcomeRate: 0.85,
    minDeterministicPassRate: 0.8,
    minFirstPassReviewRate: 0.65
  },
  high: {
    minAcceptedOutcomeRate: 0.85,
    minDeterministicPassRate: 0.8,
    minFirstPassReviewRate: 0.65
  }
};

const CAPABILITY_OVERRIDES: Partial<Record<string, Partial<Record<EvalRisk, QualityFloor>>>> = {
  "frontend-ui-change": {
    medium: {
      minAcceptedOutcomeRate: 0.82,
      minDeterministicPassRate: 0.78,
      minFirstPassReviewRate: 0.6
    }
  }
};

const CAPABILITIES = [
  "default",
  "code-feature",
  "bugfix",
  "frontend-ui-change",
  "product-spec"
] as const;

const RISKS: EvalRisk[] = ["low", "medium", "high"];

export function provisionalQualityFloors(): QualityFloorEntry[] {
  const entries: QualityFloorEntry[] = [];
  for (const capability of CAPABILITIES) {
    for (const risk of RISKS) {
      const floor = CAPABILITY_OVERRIDES[capability]?.[risk] ?? DEFAULT_FLOORS[risk];
      entries.push({
        capability,
        risk,
        floor,
        provisional: true
      });
    }
  }
  return entries;
}
