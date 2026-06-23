import { ui } from "@ui/app/state.js";
import { renderInstance } from "./render.ts";
import { allTails, getTail, type RawEvent, type TailInstance } from "./state.ts";

const COMPLETION_TYPES = new Set(["result", "end", "turn.completed"]);
const ERROR_AFTER_FAILURES = 2;

function runEndedInFeed(inst: TailInstance): boolean {
  return inst.events.some((event) => COMPLETION_TYPES.has(String(event.type ?? "")));
}

function runEndedInState(runId: string): boolean {
  const run = ui.data?.runs.find((candidate) => candidate.id === runId);
  return !!run && run.status !== "running";
}

function stopPolling(inst: TailInstance): void {
  if (inst.timer != null) {
    clearInterval(inst.timer);
    inst.timer = null;
  }
}

function markComplete(inst: TailInstance): void {
  if (inst.status === "complete") return;
  inst.status = "complete";
  inst.errorMessage = null;
  stopPolling(inst);
  renderInstance(inst);
}

function markError(inst: TailInstance, message: string): void {
  inst.status = "error";
  inst.errorMessage = message;
  renderInstance(inst);
}

/** Poll every active tail instance (e.g. after SSE run updates). */
export function pollActiveTails(): void {
  for (const inst of allTails()) {
    if (inst.timer != null && inst.status === "active") {
      void poll(inst.runId);
    }
  }
}

export async function poll(runId: string): Promise<void> {
  const inst = getTail(runId);
  if (!inst || inst.status === "complete") return;

  if (runEndedInState(runId) || runEndedInFeed(inst)) {
    markComplete(inst);
    return;
  }

  try {
    const res = await fetch(`/api/runs/${runId}/tail?since=${inst.offset}`);
    if (!res.ok) {
      inst.pollFailures += 1;
      if (inst.pollFailures >= ERROR_AFTER_FAILURES) {
        markError(inst, `Tail fetch failed (${res.status})`);
      } else {
        renderInstance(inst);
      }
      return;
    }

    const data = (await res.json()) as { size: number; chunk: string };
    inst.pollFailures = 0;
    inst.errorMessage = null;
    if (inst.status === "error") inst.status = "active";
    inst.offset = data.size;

    if (data.chunk) {
      inst.buffer += data.chunk;
      const lines = inst.buffer.split("\n");
      inst.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          inst.events.push(JSON.parse(trimmed) as RawEvent);
        } catch {
          inst.events.push({ type: "_raw", text: trimmed } as RawEvent);
        }
      }
    }

    renderInstance(inst);
    if (runEndedInState(runId) || runEndedInFeed(inst)) markComplete(inst);
  } catch (err) {
    inst.pollFailures += 1;
    const message = err instanceof Error ? err.message : "Tail connection lost";
    if (inst.pollFailures >= ERROR_AFTER_FAILURES) {
      markError(inst, message);
    } else {
      renderInstance(inst);
    }
  }
}