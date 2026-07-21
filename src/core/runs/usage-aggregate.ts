import type { RunEvent } from "./events.ts";
import { sanitizeUsage } from "./usage-normalize.ts";
import type { NormalizedUsage, UsageMetricKey, UsageReportingMode } from "./usage-types.ts";
import { USAGE_METRIC_KEYS } from "./usage-types.ts";

function emptyUsage(): NormalizedUsage {
  return {};
}

function addMetric(target: NormalizedUsage, key: UsageMetricKey, value: number): void {
  target[key] = (target[key] ?? 0) + value;
}

/** Add every present metric from `source` into `target`. */
export function mergeUsageTotals(target: NormalizedUsage, source: NormalizedUsage): NormalizedUsage {
  const next = { ...target };
  for (const key of USAGE_METRIC_KEYS) {
    const value = source[key];
    if (value !== undefined) addMetric(next, key, value);
  }
  return next;
}

function diffUsage(current: NormalizedUsage, previous: NormalizedUsage): { delta: NormalizedUsage; reset: boolean } {
  const delta: NormalizedUsage = {};
  let reset = false;
  for (const key of USAGE_METRIC_KEYS) {
    const currentValue = current[key];
    if (currentValue === undefined) continue;
    const previousValue = previous[key] ?? 0;
    if (currentValue < previousValue) {
      reset = true;
      delta[key] = currentValue;
      continue;
    }
    const nextValue = currentValue - previousValue;
    if (nextValue > 0) delta[key] = nextValue;
    else if (nextValue === 0 && currentValue === 0 && previousValue === 0) delta[key] = 0;
  }
  return { delta, reset };
}

/** ponytail: kept module-private; foldUsageEvent and aggregateUsageEvents are the only callers. */
function foldUsageEvent(
  totals: NormalizedUsage,
  state: { lastCumulative: NormalizedUsage },
  event: RunEvent
): NormalizedUsage {
  if (event.type !== "usage") return totals;
  const usage = sanitizeUsage(event.usage);
  if (!usage) return totals;

  const mode: UsageReportingMode = event.usageMode ?? "delta";
  if (mode === "cumulative") {
    const { delta, reset } = diffUsage(usage, state.lastCumulative);
    state.lastCumulative = reset ? { ...usage } : { ...state.lastCumulative, ...usage };
    return mergeUsageTotals(totals, delta);
  }
  return mergeUsageTotals(totals, usage);
}

/** Aggregate usage run events for a single run without double-counting cumulative counters. */
export function aggregateUsageEvents(events: RunEvent[]): NormalizedUsage {
  const state = { lastCumulative: emptyUsage() };
  return events.reduce((acc, event) => foldUsageEvent(acc, state, event), emptyUsage());
}
