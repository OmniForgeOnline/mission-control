import type { ToolId } from "../types.ts";
import type { RunEventInput } from "./events.ts";
import { normalizeUsageRecord } from "./usage-normalize.ts";
import type { UsageReportingMode } from "./usage-types.ts";

interface ParsedUsageEvent {
  usage: NonNullable<RunEventInput["usage"]>;
  usageMode: UsageReportingMode;
  usageRaw?: unknown;
}

function usageRunEvent(parsed: ParsedUsageEvent): RunEventInput {
  return {
    type: "usage",
    usage: parsed.usage,
    usageMode: parsed.usageMode,
    ...(parsed.usageRaw !== undefined ? { usageRaw: parsed.usageRaw } : {})
  };
}

function parseFromUsageObject(
  raw: unknown,
  mode: UsageReportingMode
): RunEventInput | null {
  const usage = normalizeUsageRecord(raw);
  if (!usage) return null;
  return usageRunEvent({ usage, usageMode: mode, usageRaw: raw });
}

function codexUsageEvent(record: Record<string, unknown>): RunEventInput | null {
  const type = String(record["type"] ?? "");
  if (type === "turn.completed" && record["usage"]) {
    return parseFromUsageObject(record["usage"], "cumulative");
  }
  if ((type === "item.completed" || type === "item.started") && record["item"] && typeof record["item"] === "object") {
    return codexUsageEvent(record["item"] as Record<string, unknown>);
  }
  if (type === "token_count" || type === "token_counts" || type === "usage" || type === "usage_delta") {
    const raw = record["usage"] ?? record;
    return parseFromUsageObject(raw, type === "usage_delta" ? "delta" : "cumulative");
  }

  const inner = (record["msg"] as Record<string, unknown> | undefined) ?? record;
  if (inner !== record) return codexUsageEvent(inner);
  return null;
}

function claudeStyleUsageEvent(record: Record<string, unknown>): RunEventInput | null {
  const type = String(record["type"] ?? "");
  if (type === "result" || type === "message_stop") {
    return parseFromUsageObject(record["usage"], "cumulative");
  }
  if (type === "message_delta" && record["usage"]) {
    return parseFromUsageObject(record["usage"], "cumulative");
  }
  if (type === "system" && record["subtype"] === "api_retry") {
    const attempt = Number(record["attempt"]);
    if (!Number.isFinite(attempt) || attempt < 1) return null;
    return usageRunEvent({
      usage: { retries: attempt - 1 },
      usageMode: "cumulative",
      usageRaw: { attempt: record["attempt"], max_retries: record["max_retries"] }
    });
  }
  return null;
}

function grokUsageEvent(record: Record<string, unknown>): RunEventInput | null {
  if (record["type"] === "result" && record["usage"]) {
    return parseFromUsageObject(record["usage"], "cumulative");
  }
  if (record["type"] === "turn.completed" && record["usage"]) {
    return parseFromUsageObject(record["usage"], "cumulative");
  }
  return null;
}

function directProviderUsageEvent(record: Record<string, unknown>): RunEventInput | null {
  if (record["type"] === "usage" && record["usage"]) {
    return parseFromUsageObject(record["usage"], "delta");
  }
  if (record["usage"] && typeof record["usage"] === "object") {
    return parseFromUsageObject(record["usage"], "delta");
  }
  return null;
}

/**
 * Parse one streamed agent event into a canonical usage run event, or null when
 * the shape carries no usage evidence. Never throws on malformed metadata.
 */
export function parseUsageFromStreamEvent(agent: ToolId, event: unknown): RunEventInput | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  try {
    if (agent === "grok") {
      return grokUsageEvent(record) ?? claudeStyleUsageEvent(record);
    }
    if (agent === "claude" || agent === "opencode") {
      return claudeStyleUsageEvent(record);
    }
    if (agent === "codex" || agent === "cursor") {
      return codexUsageEvent(record);
    }
    if (agent === "kiro") {
      return claudeStyleUsageEvent(record);
    }
    return directProviderUsageEvent(record) ?? claudeStyleUsageEvent(record) ?? codexUsageEvent(record);
  } catch {
    return null;
  }
}

export function parseUsageFromAcpUpdate(update: unknown): RunEventInput | null {
  if (!update || typeof update !== "object") return null;
  const record = update as Record<string, unknown>;
  if (record["sessionUpdate"] !== "retry_warning") return null;

  const attempt = Number(record["attempt"]);
  if (!Number.isFinite(attempt) || attempt < 1) return null;
  return usageRunEvent({
    usage: { retries: attempt - 1 },
    usageMode: "cumulative",
    usageRaw: {
      attempt: record["attempt"],
      maxAttempts: record["maxAttempts"],
      message: record["message"]
    }
  });
}
