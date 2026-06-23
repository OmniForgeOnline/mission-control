import path from "node:path";

import type { ToolId } from "../core/types.ts";

/**
 * Map a single streamed agent event to a short, human-readable activity label
 * like "editing styles.css" or "running tests". Returns null for events that
 * carry no useful signal (token counts, acks, final result, etc.).
 *
 * Both CLIs emit different event shapes, so we normalise here rather than in
 * the runner. Kept defensive: any unrecognised shape yields null instead of
 * throwing, because event schemas drift between CLI versions.
 */
export function describeAgentEvent(agent: ToolId, event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  if (agent === "grok") {
    const grokLabel = describeGrokStreamingEvent(event as Record<string, unknown>);
    if (grokLabel) return grokLabel;
  }
  if (agent === "claude" || agent === "grok" || agent === "opencode") {
    return describeClaudeEvent(event as Record<string, unknown>);
  }
  return describeCodexEvent(event as Record<string, unknown>);
}

function describeGrokStreamingEvent(event: Record<string, unknown>): string | null {
  switch (event["type"]) {
    case "thought":
      return "thinking";
    case "text":
      return "writing a response";
    default:
      return null;
  }
}

function describeClaudeEvent(event: Record<string, unknown>): string | null {
  const type = event["type"];
  if (type === "system") {
    return event["subtype"] === "init" ? "starting up" : null;
  }
  if (type === "assistant") {
    const content = messageContent(event["message"]);
    // Prefer the most concrete action in the turn: a tool use beats prose.
    for (const part of content) {
      const label = describeClaudeToolUse(part);
      if (label) return label;
    }
    if (content.some((p) => partType(p) === "text" && hasText(p))) {
      return "writing a response";
    }
    return null;
  }
  if (type === "user") {
    // Tool results flowing back in — the agent is digesting output.
    const content = messageContent(event["message"]);
    if (content.some((p) => partType(p) === "tool_result")) return "reviewing results";
    return null;
  }
  // "result" is the terminal event; the turn is ending, not active work.
  return null;
}

function describeClaudeToolUse(part: unknown): string | null {
  if (partType(part) !== "tool_use") return null;
  const record = part as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : "";
  const input = (record["input"] as Record<string, unknown> | undefined) ?? {};
  return labelForTool(name, input);
}

function describeCodexEvent(event: Record<string, unknown>): string | null {
  // Newer codex CLI emits item.* events with nested item payloads.
  if (event["type"] === "item.completed" && event["item"] && typeof event["item"] === "object") {
    return describeCodexEvent(event["item"] as Record<string, unknown>);
  }
  if (event["type"] === "item.started" && event["item"] && typeof event["item"] === "object") {
    return describeCodexEvent(event["item"] as Record<string, unknown>);
  }

  // Codex wraps payloads under `msg`, e.g. { msg: { type: "exec_command_begin", command: [...] } }.
  const inner = (event["msg"] as Record<string, unknown> | undefined) ?? event;
  const type = String(inner["type"] ?? inner["event"] ?? inner["kind"] ?? "");
  switch (type) {
    case "task_started":
    case "session_configured":
      return "starting up";
    case "agent_reasoning":
    case "reasoning":
      return "thinking";
    case "agent_message":
    case "assistant_message":
      return "writing a response";
    case "exec_command_begin":
    case "exec_command": {
      const command = normalizeCommand(inner["command"] ?? inner["cmd"]);
      return command ? labelForCommand(command) : "running a command";
    }
    case "patch_apply_begin":
    case "apply_patch": {
      const file = firstPatchFile(inner);
      return file ? `editing ${path.basename(file)}` : "editing files";
    }
    case "mcp_tool_call_begin":
    case "tool_call": {
      const name =
        typeof inner["tool"] === "string"
          ? inner["tool"]
          : typeof inner["name"] === "string"
            ? inner["name"]
            : "";
      return name ? `calling ${shortToolName(name)}` : "calling a tool";
    }
    default:
      return null;
  }
}

/** Shared tool→label mapping for Claude's named tools. */
function labelForTool(name: string, input: Record<string, unknown>): string | null {
  const file = firstString(input, ["file_path", "path", "notebook_path"]);
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return file ? `editing ${path.basename(file)}` : "editing files";
    case "Read":
      return file ? `reading ${path.basename(file)}` : "reading a file";
    case "Bash":
    case "BashOutput": {
      const command = typeof input["command"] === "string" ? input["command"] : "";
      return command ? labelForCommand(command) : "running a command";
    }
    case "Grep":
    case "Glob":
      return "searching the codebase";
    case "TodoWrite":
      return "updating its plan";
    case "WebFetch":
    case "WebSearch":
      return "searching the web";
    case "Task":
      return "delegating to a subagent";
    default:
      if (name.startsWith("mcp__")) return `calling ${shortToolName(name)}`;
      return name ? `using ${name}` : null;
  }
}

/** Classify a shell command into a friendly verb. */
function labelForCommand(command: string): string {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (/\b(test|vitest|jest|pytest|go test)\b/.test(trimmed)) return "running tests";
  if (/\b(build|tsc|vite build|webpack|compile)\b/.test(trimmed)) return "building";
  if (/^git\b/.test(trimmed)) {
    const sub = trimmed.split(/\s+/)[1] ?? "";
    return sub ? `git ${sub}` : "running git";
  }
  if (/\b(lint|eslint|prettier|ruff|black)\b/.test(trimmed)) return "linting";
  if (/^(npm|pnpm|yarn|bun)\b/.test(trimmed)) return "running a package script";
  return `running ${first || "a command"}`;
}

function normalizeCommand(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((p) => typeof p === "string").join(" ");
  return "";
}

function firstPatchFile(inner: Record<string, unknown>): string | undefined {
  const direct = firstString(inner, ["path", "file", "file_path"]);
  if (direct) return direct;
  const changes = inner["changes"] ?? inner["files"];
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (typeof change === "string") return change;
      if (change && typeof change === "object") {
        const f = firstString(change as Record<string, unknown>, ["path", "file", "file_path"]);
        if (f) return f;
      }
    }
  } else if (changes && typeof changes === "object") {
    const keys = Object.keys(changes as Record<string, unknown>);
    if (keys.length) return keys[0];
  }
  return undefined;
}

function shortToolName(name: string): string {
  // mcp__gbrain__search -> gbrain search
  return name.replace(/^mcp__/, "").replace(/__/g, " ");
}

function messageContent(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>)["content"];
  if (Array.isArray(content)) return content;
  return [];
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

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}