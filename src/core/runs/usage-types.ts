/** Agent-agnostic provider usage counters. Absent fields mean unknown, not zero. */
export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  retries?: number;
}

/** How a provider reported the usage snapshot relative to prior reports in the same run. */
export type UsageReportingMode = "delta" | "cumulative";

export const USAGE_METRIC_KEYS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "retries"
] as const satisfies ReadonlyArray<keyof NormalizedUsage>;

export type UsageMetricKey = (typeof USAGE_METRIC_KEYS)[number];
