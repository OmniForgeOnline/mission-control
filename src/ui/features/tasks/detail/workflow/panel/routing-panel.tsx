import { useEffect, useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import type { HarnessRun } from "@ui/app/types.js";

export interface RoutingDecisionRecord {
  harness: string;
  modelPoolId: string;
  capability: string;
  source: "pin" | "preferred" | "optimizer-fallback";
  reason: string;
  provider: string;
  configuredModel: string;
  resolvedModel: string;
  quotaState: string;
  rankingBasis?: string;
  rejected: Array<{
    toolId: string;
    modelPoolId: string;
    reason: string;
    detail?: string;
  }>;
}

export interface RoutingDecisionView {
  decision: RoutingDecisionRecord;
  effort?: string;
}

function sourceLabel(source: RoutingDecisionRecord["source"]): string {
  switch (source) {
    case "pin":
      return "pinned";
    case "optimizer-fallback":
      return "fallback";
    default:
      return "routed";
  }
}

export function RoutingSummaryLine({
  decision,
  effort
}: {
  decision: RoutingDecisionRecord;
  effort?: string;
}) {
  return (
    <p class="wf-routing-summary">
      <span class={`wf-routing-source is-${decision.source}`}>{sourceLabel(decision.source)}</span>
      <span class="mono">
        {decision.harness}/{decision.modelPoolId}
      </span>
      <span class="muted">
        {decision.provider}/{decision.resolvedModel} · {decision.capability}
        {effort ? ` · effort ${effort}` : ""} · quota {decision.quotaState}
      </span>
    </p>
  );
}

export function RoutingDecisionPanel({
  taskId,
  stepId,
  run
}: {
  taskId?: string;
  stepId?: string;
  run?: HarnessRun;
}) {
  const [view, setView] = useState<RoutingDecisionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const endpoint = run
          ? `/api/runs/${run.id}/routing`
          : taskId && stepId
            ? `/api/tasks/${taskId}/steps/${encodeURIComponent(stepId)}/routing`
            : null;
        if (!endpoint) return;
        const payload = await api<RoutingDecisionView>(endpoint);
        if (!cancelled) {
          setView(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [taskId, stepId, run?.id]);

  if (error) return null;
  if (!view) return null;

  const rejected = view.decision.rejected ?? [];

  return (
    <details class="wf-routing-panel">
      <summary>
        <span class="k">Routing</span>
        <RoutingSummaryLine
          decision={view.decision}
          {...(view.effort ? { effort: view.effort } : {})}
        />
      </summary>
      <div class="wf-routing-body" role="region" aria-label="Routing decision details">
        <p class="wf-routing-reason">{view.decision.reason}</p>
        {view.effort ? (
          <p class="wf-routing-effort">
            Effort <span class="mono">{view.effort}</span>
          </p>
        ) : null}
        {rejected.length ? (
          <details class="wf-routing-rejected">
            <summary>{rejected.length} rejected candidate{rejected.length === 1 ? "" : "s"}</summary>
            <ul>
              {rejected.map((entry) => (
                <li key={`${entry.toolId}:${entry.modelPoolId}:${entry.reason}`}>
                  <span class="mono">
                    {entry.toolId}/{entry.modelPoolId}
                  </span>
                  <span class="muted">
                    {entry.reason}
                    {entry.detail ? ` — ${entry.detail}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </details>
  );
}
