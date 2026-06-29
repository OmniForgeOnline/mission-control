import type { RunEventInput } from "../../core/runs/events.ts";

/**
 * Map one ACP `session/update` notification payload into canonical run events.
 * ACP carries the discriminator on `update.sessionUpdate`. Defensive: unknown
 * shapes yield [] because the protocol's content blocks vary by version/tool.
 */
export function runEventsFromAcpUpdate(update: unknown): RunEventInput[] {
  if (!update || typeof update !== "object") return [];
  const record = update as Record<string, unknown>;
  const kind = record["sessionUpdate"];

  switch (kind) {
    case "agent_message_chunk": {
      const text = contentText(record["content"]);
      return text ? [{ type: "text_delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = contentText(record["content"]);
      return text ? [{ type: "thinking_delta", text }] : [];
    }
    case "tool_call": {
      const tool = firstString(record, ["title", "kind"]) ?? "tool";
      return [
        {
          type: "tool_call",
          tool,
          ...(record["rawInput"] !== undefined ? { toolInput: record["rawInput"] } : {})
        }
      ];
    }
    case "tool_call_update": {
      const tool = firstString(record, ["title", "toolCallId"]) ?? "tool";
      const result = record["content"] ?? record["status"];
      return [{ type: "tool_result", tool, ...(result !== undefined ? { toolResult: result } : {}) }];
    }
    case "retry_warning": {
      const text = typeof record["message"] === "string" ? record["message"] : undefined;
      return text ? [{ type: "agent_status", text }] : [];
    }
    default:
      return [];
  }
}

export function runEventsFromAcpNotification(method: string, params: unknown): RunEventInput[] {
  if (method === "_kiro.dev/error/rate_limit") {
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    const text = typeof record["message"] === "string" ? record["message"] : "Kiro rate limit exceeded.";
    return [{ type: "error", text }];
  }

  if (method === "_kiro.dev/session/update") {
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    return runEventsFromAcpUpdate(record["update"]);
  }

  return [];
}

/** Extract plain text from an ACP content block or array of blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record["text"] === "string") return record["text"];
  }
  return "";
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
