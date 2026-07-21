import type { NormalizedUsage } from "./usage-types.ts";

const FIELD_ALIASES: Record<keyof NormalizedUsage, string[]> = {
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  outputTokens: ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
  cachedInputTokens: [
    "cached_input_tokens",
    "cachedInputTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read"
  ],
  cacheWriteTokens: [
    "cache_write_tokens",
    "cacheWriteTokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation"
  ],
  reasoningTokens: ["reasoning_tokens", "reasoningTokens", "thinking_tokens", "thinkingTokens"],
  retries: ["retries", "retry_count", "retryCount"]
};

/** Parse a non-negative finite integer metric; absent or malformed values become undefined. */
export function parseUsageMetric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function readMetric(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = parseUsageMetric(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Map a provider usage object into normalized counters, omitting unknown fields. */
export function normalizeUsageRecord(raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const usage: NormalizedUsage = {};

  for (const [metric, aliases] of Object.entries(FIELD_ALIASES) as Array<
    [keyof NormalizedUsage, string[]]
  >) {
    const value = readMetric(record, aliases);
    if (value !== undefined) usage[metric] = value;
  }

  return Object.keys(usage).length ? usage : null;
}

/** Return a shallow copy containing only valid normalized metrics. */
export function sanitizeUsage(usage: NormalizedUsage | undefined): NormalizedUsage | null {
  if (!usage) return null;
  const clean: NormalizedUsage = {};
  for (const key of Object.keys(FIELD_ALIASES) as Array<keyof NormalizedUsage>) {
    const value = parseUsageMetric(usage[key]);
    if (value !== undefined) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : null;
}
