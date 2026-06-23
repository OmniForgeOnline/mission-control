import { describe, expect, it } from "vitest";

import {
  appendRunActivityEntry,
  deriveRunActivity,
  type RunActivityEntry
} from "../src/core/runs/activity.ts";
import type { RunEvent } from "../src/core/runs/events.ts";

function ev(partial: Partial<RunEvent> & { type: RunEvent["type"] }, seq: number): RunEvent {
  return { seq, at: new Date(seq).toISOString(), ...partial };
}

describe("run activity presentation", () => {
  it("collapses thinking by default while preserving the full text", () => {
    const entries = deriveRunActivity([
      ev({ type: "thinking_delta", text: "checking " }, 1),
      ev({ type: "thinking_delta", text: "the workflow" }, 2),
      ev({ type: "tool_call", tool: "bash", toolInput: "npm run test" }, 3),
      ev({ type: "text_delta", text: "Tests pass." }, 4),
      ev({ type: "done", exitCode: 0 }, 5)
    ]);

    expect(entries).toEqual<RunActivityEntry[]>([
      {
        id: "thinking-1",
        kind: "thinking",
        title: "Thinking",
        text: "checking the workflow",
        defaultExpanded: false,
        eventSeq: 2,
        at: new Date(2).toISOString()
      },
      {
        id: "action-3",
        kind: "action",
        title: "bash",
        detail: "npm run test",
        defaultExpanded: true,
        eventSeq: 3,
        at: new Date(3).toISOString()
      },
      {
        id: "message-4",
        kind: "message",
        title: "Agent message",
        text: "Tests pass.",
        defaultExpanded: true,
        eventSeq: 4,
        at: new Date(4).toISOString()
      },
      {
        id: "status-5",
        kind: "status",
        title: "Turn complete",
        defaultExpanded: true,
        eventSeq: 5,
        at: new Date(5).toISOString()
      }
    ]);
  });

  it("updates incrementally without rebuilding previous entries", () => {
    let entries: RunActivityEntry[] = [];
    entries = appendRunActivityEntry(entries, ev({ type: "thinking_delta", text: "one " }, 1));
    entries = appendRunActivityEntry(entries, ev({ type: "thinking_delta", text: "two" }, 2));
    entries = appendRunActivityEntry(entries, ev({ type: "tool_call", tool: "edit" }, 3));
    entries = appendRunActivityEntry(entries, ev({ type: "thinking_delta", text: "three" }, 4));

    expect(entries.map((entry) => [entry.kind, entry.text, entry.eventSeq])).toEqual([
      ["thinking", "one two", 2],
      ["action", undefined, 3],
      ["thinking", "three", 4]
    ]);
  });

  it("drops raw bookkeeping events from the operator activity feed", () => {
    expect(
      deriveRunActivity([
        ev({ type: "session_id", sessionId: "session-1" }, 1),
        ev({ type: "raw", text: "{\"type\":\"usage\"}" }, 2),
        ev({ type: "stderr", text: "warning" }, 3)
      ])
    ).toEqual([]);
  });
}
);
