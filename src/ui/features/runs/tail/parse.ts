import type { ContentItem, RawEvent, Row } from "./state.ts";

export function coalesceStreamEvents(source: RawEvent[]): RawEvent[] {
  const merged: RawEvent[] = [];
  for (const ev of source) {
    const type = ev.type;
    const prev = merged.at(-1);
    if (type === "thought" && prev?.type === "thought") {
      prev["data"] = `${String(prev["data"] ?? "")}${String(ev["data"] ?? "")}`;
      continue;
    }
    if (type === "text" && prev?.type === "text") {
      prev["data"] = `${String(prev["data"] ?? "")}${String(ev["data"] ?? "")}`;
      continue;
    }
    merged.push({ ...ev });
  }
  return merged;
}

export function toRows(ev: RawEvent, i: number): Row[] {
  if (isNoisyProtocolEvent(ev)) return [];
  if (ev.type === "assistant" || ev.type === "user") {
    const items = ev.message?.content ?? [];
    return items.flatMap((item, j) => contentRow(item, `${i}:${j}`)).filter(Boolean) as Row[];
  }
  if (ev.type === "system") return systemRow(ev, `${i}:s`);
  if (ev.type === "result") {
    return [{ id: `${i}:r`, ico: "check", kind: "turn", title: "turn complete", tone: "ok" }];
  }
  if (ev.type === "thought") {
    const text = String(ev["data"] ?? "").trim();
    if (!text) return [];
    return [
      {
        id: `${i}:th`,
        ico: "sparkles",
        kind: "thinking",
        title: firstLine(text),
        detail: text,
        tone: "muted"
      }
    ];
  }
  if (ev.type === "text") {
    const text = String(ev["data"] ?? "").trim();
    if (!text) return [];
    return [{ id: `${i}:tx`, ico: "bot", kind: "assistant", title: "message", body: text, tone: "default" }];
  }
  if (ev.type === "error") {
    const text = String(ev.message ?? ev["data"] ?? ev["error"] ?? "").trim();
    return [
      {
        id: `${i}:er`,
        ico: "alert-triangle",
        kind: "error",
        title: summarize(text || "agent error"),
        detail: text || pretty(ev),
        tone: "error"
      }
    ];
  }
  if (ev.type === "end") {
    const reason = typeof ev["stopReason"] === "string" ? ev["stopReason"] : "turn ended";
    return [{ id: `${i}:end`, ico: "check", kind: "turn", title: reason, tone: reason === "Cancelled" ? "warn" : "ok" }];
  }
  if (ev.type === "turn.completed") {
    return [{ id: `${i}:tc`, ico: "check", kind: "turn", title: "turn complete", tone: "ok" }];
  }
  if (ev.type === "turn.started" || ev.type === "thread.started") {
    return [
      {
        id: `${i}:ts`,
        ico: "zap",
        kind: "system",
        title: ev.type === "thread.started" ? "thread started" : "turn started",
        detail: pretty(ev),
        tone: "muted"
      }
    ];
  }
  if (ev.type === "item.completed" || ev.type === "item.started") {
    return codexItemRow(ev, `${i}:item`);
  }
  if (ev.type === "_raw") {
    return [{ id: `${i}:x`, ico: "file", kind: "raw", title: "unparsed line", detail: String(ev["text"] ?? ""), tone: "muted" }];
  }
  return [];
}

function codexItemRow(ev: RawEvent, id: string): Row[] {
  const item = (ev["item"] as Record<string, unknown> | undefined) ?? {};
  const itemType = String(item["type"] ?? "");
  if (itemType === "agent_message") {
    const text = String(item["text"] ?? "").trim();
    if (!text) return [];
    return [{ id, ico: "bot", kind: "assistant", title: "message", body: text, tone: "default" }];
  }
  if (itemType === "command_execution") {
    const command = String(item["command"] ?? "").trim();
    return [
      {
        id,
        ico: "terminal",
        kind: "tool",
        title: command ? labelForCommand(command) : "running a command",
        detail: pretty(item),
        tone: ev.type === "item.completed" ? "ok" : "accent"
      }
    ];
  }
  return [
    {
      id,
      ico: "more-horizontal",
      kind: "system",
      title: itemType || String(ev.type ?? "item"),
      detail: pretty(ev),
      tone: "muted"
    }
  ];
}

function isNoisyProtocolEvent(ev: RawEvent): boolean {
  const type = String(ev.type ?? "");
  const subtype = String(ev.subtype ?? "");
  if (isNoisyProtocolName(type) || isNoisyProtocolName(subtype)) return true;

  if ((type === "item.completed" || type === "item.started") && ev["item"] && typeof ev["item"] === "object") {
    const item = ev["item"] as Record<string, unknown>;
    return isNoisyProtocolName(String(item["type"] ?? ""));
  }

  return false;
}

function isNoisyProtocolName(name: string): boolean {
  return [
    "thinking_tokens",
    "token_count",
    "token_counts",
    "tokens",
    "usage",
    "usage_delta"
  ].includes(name);
}

function contentRow(item: ContentItem, id: string): Row | null {
  if (item.type === "text") {
    const text = (item.text ?? "").trim();
    if (!text) return null;
    return { id, ico: "bot", kind: "assistant", title: "message", body: text, tone: "default" };
  }
  if (item.type === "thinking") {
    const text = (item.thinking ?? "").trim();
    if (!text) return null;
    return {
      id,
      ico: "sparkles",
      kind: "thinking",
      title: firstLine(text),
      detail: text,
      tone: "muted"
    };
  }
  if (item.type === "tool_use") {
    return {
      id,
      ico: "terminal",
      kind: "tool",
      title: toolLabel(item.name ?? "tool", item.input ?? {}),
      detail: pretty(item.input ?? {}),
      tone: "accent"
    };
  }
  if (item.type === "tool_result") {
    const text = resultText(item.content);
    const err = item.is_error === true;
    return {
      id,
      ico: err ? "alert-triangle" : "check",
      kind: "result",
      title: err ? "error" : summarize(text),
      detail: text,
      tone: err ? "error" : "ok"
    };
  }
  return null;
}

function systemRow(ev: RawEvent, id: string): Row[] {
  switch (ev.subtype) {
    case "init":
      return [
        {
          id,
          ico: "zap",
          kind: "system",
          title: `session started${ev.model ? ` · ${ev.model}` : ""}`,
          detail: pretty({ model: ev.model, cwd: ev.cwd, session_id: ev["session_id"] }),
          tone: "muted"
        }
      ];
    case "hook_started":
    case "hook_response":
      return [
        {
          id,
          ico: "shield",
          kind: "hook",
          title: String(ev.hook_name ?? ev.subtype),
          detail: pretty(ev),
          tone: "muted"
        }
      ];
    case "api_retry":
      return [
        {
          id,
          ico: "refresh",
          kind: "retry",
          title: `api retry · attempt ${ev.attempt ?? "?"}/${ev.max_retries ?? "?"}`,
          tone: "warn"
        }
      ];
    case "task_started":
      return [
        {
          id,
          ico: "workflow",
          kind: "subagent",
          title: String(ev.description ?? ev.subagent_type ?? "subagent started"),
          detail: pretty(ev),
          tone: "accent"
        }
      ];
    default:
      return [
        {
          id,
          ico: "more-horizontal",
          kind: "system",
          title: String(ev.subtype ?? "event"),
          detail: pretty(ev),
          tone: "muted"
        }
      ];
  }
}

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

function toolLabel(name: string, input: Record<string, unknown>): string {
  const arg =
    (input["file_path"] as string) ??
    (input["command"] as string) ??
    (input["pattern"] as string) ??
    (input["description"] as string) ??
    (input["path"] as string) ??
    (input["url"] as string) ??
    (input["query"] as string) ??
    (input["subagent_type"] as string);
  const clean = name.replace(/^mcp__/, "").replace(/__/g, "·");
  return arg ? `${clean} · ${truncate(String(arg), 80)}` : clean;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : pretty(c)))
      .join("\n");
  }
  if (content == null) return "";
  return pretty(content);
}

function summarize(text: string): string {
  const line = firstLine(text);
  const chars = text.length;
  if (!line) return `result · ${chars} chars`;
  return chars > 120 ? `${truncate(line, 100)} · ${chars} chars` : line;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return truncate(line.trim(), 120);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
