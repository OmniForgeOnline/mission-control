import type { RunEvent } from "@harness/core/runs/events.ts";

/**
 * Subscribe to a run's canonical event stream over SSE. Replays from `since`
 * (sequence offset) then streams live. Returns an unsubscribe function that
 * closes the EventSource.
 */
export function subscribeRunEventStream(
  runId: string,
  since: number,
  onEvent: (event: RunEvent) => void
): () => void {
  const source = new EventSource(`/api/runs/${runId}/events?since=${since}`);
  source.addEventListener("run-event", (event) => {
    try {
      onEvent(JSON.parse((event as MessageEvent).data) as RunEvent);
    } catch {
      /* ignore malformed event */
    }
  });
  return () => source.close();
}
