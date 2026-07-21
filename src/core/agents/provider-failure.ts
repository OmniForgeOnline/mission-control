/**
 * Detect provider quota, billing, and rate-limit failures from agent CLI output.
 * Shared by usage exhaustion tracking, blockedReason enrichment, and UI hints.
 */

export const PROVIDER_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /429\b/,
  /too many requests/i,
  /quota\s+(exceeded|exhausted|depleted)/i,
  /usage\s+limit/i,
  /out\s+of\s+(usage|credits)/i,
  /credit/i,
  /upgrade\s+(your|the\s)?plan/i,
  /billing/i,
  /payment/i,
  /subscription/i,
  /capacity/i,
  /insufficient/i,
  /unauthorized/i,
  /forbidden/i,
  /payment_required/i,
  /error_max_budget/i,
  /billing_error/i
];

export function matchesProviderLimit(text: string): boolean {
  return PROVIDER_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

function tryJson(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function unwrapErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  const parsed = tryJson(trimmed);
  if (!parsed) return trimmed;
  const direct = firstString(parsed, ["message", "result", "error"]);
  if (direct) return direct;
  const err = parsed["error"];
  if (err && typeof err === "object") {
    const inner = firstString(err as Record<string, unknown>, ["message"]);
    if (inner) return inner;
  }
  if (typeof err === "string" && err.trim()) return err.trim();
  return trimmed;
}

function extractClaudeResultError(record: Record<string, unknown>): string | undefined {
  if (record["is_error"] !== true) return undefined;

  const errors = record["errors"];
  if (Array.isArray(errors)) {
    const parts = errors
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") {
          return firstString(entry as Record<string, unknown>, ["message", "error"]);
        }
        return undefined;
      })
      .filter((value): value is string => Boolean(value));
    if (parts.length > 0) return parts.join("; ");
  }

  const fromFields =
    firstString(record, ["result", "error", "message"]) ??
    (typeof record["error"] === "string" ? record["error"].trim() : undefined);
  if (fromFields) return unwrapErrorMessage(fromFields);

  const subtype = record["subtype"];
  if (typeof subtype === "string" && !["success", "completion"].includes(subtype)) {
    return subtype.replace(/_/g, " ");
  }

  const status = record["api_error_status"];
  if (typeof status === "number") return `API error (HTTP ${status})`;
  return "Agent reported an error";
}

function extractStructuredError(record: Record<string, unknown>, agent: string): string | undefined {
  const type = String(record["type"] ?? "");

  if (type === "turn.failed") {
    const err = record["error"];
    const msg =
      (err && typeof err === "object"
        ? firstString(err as Record<string, unknown>, ["message"])
        : undefined) ?? firstString(record, ["message"]);
    if (msg) return msg;
  }

  if (type === "error") {
    return firstString(record, ["message", "error", "data"]);
  }

  if (agent === "claude" || agent === "opencode") {
    if (type === "result" || type === "final") {
      return extractClaudeResultError(record);
    }
  }

  return undefined;
}

/**
 * Best-effort extraction when parseAgentOutput did not surface errorReason.
 * Scans structured NDJSON first, then raw lines that look like provider limits.
 */
export function inferAgentFailureReason(stdout: string, stderr: string, agent: string): string | undefined {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return undefined;

  let terminalError: string | undefined;
  let topLevelError: string | undefined;

  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const record = tryJson(trimmed);
    if (!record) continue;

    const type = String(record["type"] ?? "");
    const structured = extractStructuredError(record, agent);
    if (!structured) continue;

    if (type === "result" || type === "final" || type === "turn.failed") {
      terminalError = structured;
    } else {
      topLevelError = structured;
    }
  }

  const structured = terminalError ?? topLevelError;
  if (structured) return unwrapErrorMessage(structured);

  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("{")) continue;
    if (matchesProviderLimit(trimmed)) return trimmed.slice(0, 500);
  }

  return undefined;
}
