import type { ToolId } from "../types.ts";
import { extractSessionIdFromStreamEvent } from "../agents/output.ts";
import type { RunEventInput } from "./events.ts";

/**
 * Map one parsed agent stream event into zero or more canonical RunEvents.
 * Defensive by design: unrecognized shapes yield [] rather than throwing,
 * because CLI event schemas drift between versions.
 */
export function runEventsFromStreamEvent(agent: ToolId, event: unknown): RunEventInput[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  const events: RunEventInput[] = [];

  const sessionId = extractSessionIdFromStreamEvent(event);
  if (sessionId) events.push({ type: "session_id", sessionId });

  if (agent === "grok") {
    events.push(...grokEvents(record));
  } else if (agent === "claude" || agent === "opencode") {
    events.push(...claudeStyleEvents(record));
  } else {
    events.push(...codexEvents(record));
  }
  return events;
}

function grokEvents(record: Record<string, unknown>): RunEventInput[] {
  const type = record["type"];
  if (type === "text" && typeof record["data"] === "string") {
    return [{ type: "text_delta", text: record["data"] }];
  }
  if (type === "thought") {
    const text = str(record["data"]);
    return [{ type: "thinking_delta", ...(text ? { text } : {}) }];
  }
  if (type === "error") {
    const text = firstString(record, ["message", "data", "error"]);
    return text ? [{ type: "error", text }] : [];
  }
  return [];
}

function claudeStyleEvents(record: Record<string, unknown>): RunEventInput[] {
  const type = record["type"];
  if (type === "assistant") {
    const events: RunEventInput[] = [];
    for (const part of messageContent(record["message"])) {
      const pt = partType(part);
      const partRecord = part as Record<string, unknown>;
      if (pt === "text" && hasText(part)) {
        events.push({ type: "text_delta", text: partRecord["text"] as string });
      } else if (pt === "thinking") {
        const text = str(partRecord["thinking"]) ?? str(partRecord["text"]);
        if (text) events.push({ type: "thinking_delta", text });
      } else if (pt === "tool_use") {
        const tool = str(partRecord["name"]);
        events.push({
          type: "tool_call",
          ...(tool ? { tool } : {}),
          ...(partRecord["input"] !== undefined ? { toolInput: partRecord["input"] } : {})
        });
      }
    }
    return events;
  }
  if (type === "user") {
    const events: RunEventInput[] = [];
    for (const part of messageContent(record["message"])) {
      if (partType(part) === "tool_result") {
        const partRecord = part as Record<string, unknown>;
        events.push({ type: "tool_result", toolResult: partRecord["content"] ?? partRecord });
      }
    }
    return events;
  }
  return [];
}

function codexEvents(record: Record<string, unknown>): RunEventInput[] {
  if (
    (record["type"] === "item.completed" || record["type"] === "item.started") &&
    record["item"] &&
    typeof record["item"] === "object"
  ) {
    return codexEvents(record["item"] as Record<string, unknown>);
  }
  const inner = (record["msg"] as Record<string, unknown> | undefined) ?? record;
  const type = String(inner["type"] ?? inner["event"] ?? inner["kind"] ?? "");
  switch (type) {
    case "agent_reasoning":
    case "reasoning": {
      const text = firstString(inner, ["text", "message", "content"]);
      return [{ type: "thinking_delta", ...(text ? { text } : {}) }];
    }
    case "agent_message":
    case "assistant_message": {
      const text = firstString(inner, ["message", "text", "content"]);
      return text ? [{ type: "text_delta", text }] : [];
    }
    case "exec_command_begin":
    case "exec_command": {
      const command = normalizeCommand(inner["command"] ?? inner["cmd"]);
      return [{ type: "tool_call", tool: "bash", ...(command ? { toolInput: command } : {}) }];
    }
    case "patch_apply_begin":
    case "apply_patch":
      return [{ type: "tool_call", tool: "edit" }];
    case "mcp_tool_call_begin":
    case "tool_call": {
      const tool = firstString(inner, ["tool", "name"]);
      return [{ type: "tool_call", ...(tool ? { tool } : {}) }];
    }
    default:
      return [];
  }
}

function messageContent(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>)["content"];
  return Array.isArray(content) ? content : [];
}

function partType(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const t = (part as Record<string, unknown>)["type"];
  return typeof t === "string" ? t : "";
}

function hasText(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const text = (part as Record<string, unknown>)["text"];
  return typeof text === "string" && text.trim().length > 0;
}

function normalizeCommand(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join(" ");
  return "";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
