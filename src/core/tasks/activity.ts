/**
 * Liveness + stall-detection tuning, single-sourced so the daemon, server, and
 * client all agree. The client reads these via /api/state so there is no second
 * copy to drift.
 */

/** How often the daemon flushes the latest observed agent activity to disk. */
export const HEARTBEAT_INTERVAL_MS = 3_000;

/**
 * No agent event for this long while a turn is running => surface a "no activity"
 * warning. Coarse events (tool calls, messages) normally arrive far more often,
 * so a multi-minute gap is a real signal. Kept generous because a single long
 * step (a slow test run, a long model turn) legitimately produces no events.
 */
const ACTIVITY_STALE_MS = 4 * 60_000;

/**
 * A single turn running longer than this is flagged as "running long". Purely
 * informational — long first turns can be legitimate — never an auto-kill.
 */
const ACTIVITY_LONG_RUN_MS = 20 * 60_000;

export interface ActivityThresholds {
  staleMs: number;
  longRunMs: number;
}

export const ACTIVITY_THRESHOLDS: ActivityThresholds = {
  staleMs: ACTIVITY_STALE_MS,
  longRunMs: ACTIVITY_LONG_RUN_MS
};
