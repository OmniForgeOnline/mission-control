import type { RunEvent } from "./events.ts";

export type RunActivityKind = "action" | "message" | "thinking" | "operator" | "status" | "error";

export interface RunActivityEntry {
  id: string;
  kind: RunActivityKind;
  title: string;
  detail?: string;
  text?: string;
  defaultExpanded: boolean;
  eventSeq: number;
  at: string;
}

export function deriveRunActivity(events: RunEvent[]): RunActivityEntry[] {
  return events.reduce<RunActivityEntry[]>(appendRunActivityEntry, []);
}

export function appendRunActivityEntry(entries: RunActivityEntry[], event: RunEvent): RunActivityEntry[] {
  const next = entryFromEvent(event);
  if (!next) return entries;

  const previous = entries[entries.length - 1];
  if (previous && canCoalesce(previous, next)) {
    return [
      ...entries.slice(0, -1),
      {
        ...previous,
        text: `${previous.text ?? ""}${next.text ?? ""}`,
        eventSeq: next.eventSeq,
        at: next.at
      }
    ];
  }

  return [...entries, next];
}

function entryFromEvent(event: RunEvent): RunActivityEntry | null {
  switch (event.type) {
    case "thinking_delta":
      return textEntry(event, "thinking", "Thinking", false);
    case "text_delta":
      return textEntry(event, "message", "Agent message", true);
    case "operator_message":
      return textEntry(event, "operator", "Operator message", true);
    case "tool_call":
      {
        const detail = toolDetail(event.toolInput);
        return {
          id: `action-${event.seq}`,
          kind: "action",
          title: event.tool ?? "tool",
          ...(detail ? { detail } : {}),
          defaultExpanded: true,
          eventSeq: event.seq,
          at: event.at
        };
      }
    case "permission_request":
      return {
        id: `action-${event.seq}`,
        kind: "action",
        title: "Permission requested",
        ...(event.text ? { text: event.text } : {}),
        defaultExpanded: true,
        eventSeq: event.seq,
        at: event.at
      };
    case "agent_status":
      return textEntry(event, "status", event.text ?? "Agent status", true);
    case "done":
      return {
        id: `status-${event.seq}`,
        kind: "status",
        title: "Turn complete",
        defaultExpanded: true,
        eventSeq: event.seq,
        at: event.at
      };
    case "error":
      return {
        id: `error-${event.seq}`,
        kind: "error",
        title: "Turn failed",
        ...(event.text ? { text: event.text } : {}),
        defaultExpanded: true,
        eventSeq: event.seq,
        at: event.at
      };
    default:
      return null;
  }
}

function textEntry(
  event: RunEvent,
  kind: RunActivityKind,
  title: string,
  defaultExpanded: boolean
): RunActivityEntry | null {
  if (!event.text) return null;
  return {
    id: `${kind}-${event.seq}`,
    kind,
    title,
    text: event.text,
    defaultExpanded,
    eventSeq: event.seq,
    at: event.at
  };
}

function canCoalesce(previous: RunActivityEntry, next: RunActivityEntry): boolean {
  return previous.kind === next.kind && (next.kind === "thinking" || next.kind === "message");
}

function toolDetail(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const command = record["command"] ?? record["cmd"];
  if (typeof command === "string") return command;
  const filePath = record["file_path"] ?? record["path"];
  if (typeof filePath === "string") return filePath;
  return undefined;
}
