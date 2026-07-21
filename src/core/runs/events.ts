import { EventEmitter } from "node:events";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../infra/fs.ts";
import type { NormalizedUsage, UsageReportingMode } from "./usage-types.ts";

/**
 * Canonical, agent-agnostic event model for a single run. Agent CLIs emit
 * wildly different stream shapes; the normalizer maps them into these so the
 * SSE channel and UI transcript can be agent-independent. Persisted as
 * data/runs/<id>/events.ndjson (additive — raw stdout still lands in log.txt).
 */
export type RunEventType =
  | "agent_status"
  | "text_delta"
  | "thinking_delta"
  | "tool_call"
  | "tool_result"
  | "permission_request"
  | "operator_message"
  | "session_id"
  | "stderr"
  | "raw"
  | "usage"
  | "done"
  | "error";

export interface RunEvent {
  /** Monotonic 1-based sequence within the run; used as the replay offset. */
  seq: number;
  /** ISO timestamp. */
  at: string;
  type: RunEventType;
  /** Human-readable text payload (text/thinking/stderr/status/operator/error). */
  text?: string;
  /** Tool name for tool_call / tool_result. */
  tool?: string;
  /** Tool input for tool_call. */
  toolInput?: unknown;
  /** Tool output for tool_result. */
  toolResult?: unknown;
  /** Resolved session id for session_id events. */
  sessionId?: string;
  /** Process exit code for done / error. */
  exitCode?: number;
  /** Normalized provider usage counters for `usage` events. */
  usage?: NormalizedUsage;
  /** Whether `usage` is incremental or a cumulative provider snapshot. */
  usageMode?: UsageReportingMode;
  /** Raw provider usage payload preserved for debugging. */
  usageRaw?: unknown;
}

export type RunEventInput = Omit<RunEvent, "seq" | "at"> & { at?: string };

const emitter = new EventEmitter();
// Many SSE clients may watch the same run; do not cap listeners.
emitter.setMaxListeners(0);

const seqCounters = new Map<string, number>();

function runEventsPath(root: string, runId: string): string {
  return path.join(root, "data", "runs", runId, "events.ndjson");
}

export async function readRunEvents(root: string, runId: string, since = 0): Promise<RunEvent[]> {
  let content: string;
  try {
    content = await readFile(runEventsPath(root, runId), "utf8");
  } catch {
    return [];
  }
  const events: RunEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as RunEvent;
      if (typeof event.seq === "number" && event.seq > since) events.push(event);
    } catch {
      /* skip malformed line */
    }
  }
  return events;
}

async function nextSeq(root: string, runId: string): Promise<number> {
  if (!seqCounters.has(runId)) {
    const existing = await readRunEvents(root, runId);
    const last = existing.length ? existing[existing.length - 1]!.seq : 0;
    seqCounters.set(runId, last);
  }
  const next = (seqCounters.get(runId) ?? 0) + 1;
  seqCounters.set(runId, next);
  return next;
}

/** Append a run event: persist to events.ndjson and emit to live subscribers. */
export async function appendRunEvent(root: string, runId: string, input: RunEventInput): Promise<RunEvent> {
  const seq = await nextSeq(root, runId);
  const { at, ...rest } = input;
  const event: RunEvent = { ...rest, seq, at: at ?? new Date().toISOString() };
  await ensureDir(path.dirname(runEventsPath(root, runId)));
  await appendFile(runEventsPath(root, runId), `${JSON.stringify(event)}\n`, "utf8");
  emitter.emit(runId, event);
  return event;
}

/** Subscribe to live run events. Returns an unsubscribe function. */
export function subscribeRunEvents(runId: string, listener: (event: RunEvent) => void): () => void {
  emitter.on(runId, listener);
  return () => {
    emitter.off(runId, listener);
  };
}
