import type { RunEvent } from "./events.ts";

export type TranscriptEntryKind = "text" | "thinking" | "tool" | "operator" | "done" | "error";

export interface TranscriptEntry {
  kind: TranscriptEntryKind;
  text?: string;
  tool?: string;
  /** For "done": whether the turn succeeded. */
  ok?: boolean;
}

/**
 * Fold a canonical run-event stream into a renderable transcript. Consecutive
 * text/thinking deltas are coalesced into a single entry so the UI shows
 * paragraphs rather than per-token fragments. Non-visual events (session_id,
 * raw, stderr) are dropped.
 */
export function buildTranscript(events: RunEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  const appendText = (kind: "text" | "thinking", text: string | undefined): void => {
    if (!text) return;
    const last = entries[entries.length - 1];
    if (last && last.kind === kind) {
      last.text = `${last.text ?? ""}${text}`;
    } else {
      entries.push({ kind, text });
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        appendText("text", event.text);
        break;
      case "thinking_delta":
        appendText("thinking", event.text);
        break;
      case "tool_call":
        entries.push({
          kind: "tool",
          ...(event.tool ? { tool: event.tool } : {}),
          ...(event.text ? { text: event.text } : {})
        });
        break;
      case "operator_message":
        entries.push({ kind: "operator", ...(event.text ? { text: event.text } : {}) });
        break;
      case "done":
        entries.push({ kind: "done", ok: true });
        break;
      case "error":
        entries.push({ kind: "error", ...(event.text ? { text: event.text } : {}) });
        break;
      default:
        // session_id, tool_result, stderr, raw, agent_status: not shown in the transcript.
        break;
    }
  }

  return entries;
}
