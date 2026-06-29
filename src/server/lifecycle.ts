import type { Server } from "node:http";

import type { DaemonHandle } from "../daemon/loop.ts";
import { abortAllInflightTurns, listInflightTaskIds } from "../runtime/sessions.ts";

/**
 * Graceful shutdown for the Mission Control server. Exactly one shutdown path
 * is wired to both the process signal handlers (Ctrl+C) and the /api/shutdown
 * route (UI button + `mission-control stop`), so every entry point tears down
 * the same way: stop launching new turns, terminate every running agent child
 * process, then close the HTTP server.
 */

export interface ShutdownTarget {
  /** Listening HTTP server; closed so the UI/API stop accepting connections. */
  server?: Server | null;
  /** Daemon loop; stopped so no new agent turns launch mid-shutdown. */
  daemon?: DaemonHandle | null;
  /** Process exit code. Defaults to 0 (130 on a forced second signal). */
  exitCode?: number;
  /**
   * Optional cleanup run after runners are terminated, e.g. removing the
   * runtime server-info file written on startup.
   */
  onShutdown?: () => void | Promise<void>;
  /**
   * Exit function, overridable in tests so the force-exit timer does not kill
   * the test runner. Defaults to process.exit.
   */
  exit?: (code: number) => void;
}

/** Bounded grace window before a forced exit. The runner's abort() schedules a
 * SIGKILL backstop at 2s, so 3s guarantees even signal-ignoring children die. */
const FORCE_EXIT_DELAY_MS = 3_000;

let target: ShutdownTarget = {};
let shuttingDown = false;
let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

/** Register the live server + daemon so shutdown can tear them down. */
export function setShutdownTarget(next: ShutdownTarget): void {
  target = next;
}

/** True once shutdown has begun. The /api/shutdown route re-entrance check and
 * the UI both read this to avoid duplicate requests. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Reset module state. Production code never calls this; tests use it to isolate cases. */
export function resetShutdownState(): void {
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
  target = {};
  shuttingDown = false;
}

function liveExit(code: number): void {
  (target.exit ?? ((value: number) => process.exit(value)))(code);
}

export interface ShutdownResult {
  /** Number of in-flight agent turns that were terminated. */
  terminated: number;
}

/**
 * Synchronously claim shutdown. Returns true if this caller is the first to
 * request it (and so should drive the teardown), false if shutdown is already
 * in progress. The /api/shutdown route claims synchronously so concurrent
 * requests (UI + CLI, or two CLI calls) collapse into a single teardown instead
 * of the second one hitting the force-exit branch below. Every entry point
 * shares one teardown; only the repeat-handling differs (see gracefulShutdown).
 */
export function beginShutdown(reason: string): boolean {
  if (shuttingDown) return false;
  shuttingDown = true;
  console.log(`Shutting down Mission Control (${reason})…`);
  return true;
}

/**
 * Run the graceful teardown: stop launching new turns, terminate every running
 * agent child process, close the HTTP server, then arm the bounded force-exit.
 * Callers must have already claimed via beginShutdown; the escalating signal
 * path uses gracefulShutdown instead.
 */
export async function runShutdownTeardown(): Promise<ShutdownResult> {
  const terminated = listInflightTaskIds().length;
  if (terminated > 0) {
    console.log(`Terminating ${terminated} running agent process(es)…`);
  }

  // Stop scheduling new turns first. stop()'s synchronous prefix flips the
  // stopped flag and clears the interval before its first await, so calling it
  // (without awaiting) is enough to prevent fresh ticks during the grace window.
  try {
    target.daemon?.stop?.();
  } catch {
    /* best effort */
  }

  // Terminate every running agent child process. The runner sends SIGTERM with
  // a SIGKILL backstop, so children die even if they ignore the signal.
  abortAllInflightTurns();

  // Stop accepting new HTTP connections (the UI/API become unavailable).
  target.server?.close();

  try {
    await target.onShutdown?.();
  } catch {
    /* best effort */
  }

  // Bounded force-exit: never hang on a child that ignores signals or a tick
  // that never settles. Fires after the runner SIGKILL backstop, so by the time
  // it runs every managed process is gone. The exit fn + code are captured now
  // so clearing shutdown state later (e.g. between tests) can't fall through to
  // a real process.exit.
  const exit = target.exit ?? ((code: number) => process.exit(code));
  const exitCode = target.exitCode ?? 0;
  forceExitTimer = setTimeout(() => {
    forceExitTimer = null;
    exit(exitCode);
  }, FORCE_EXIT_DELAY_MS);

  return { terminated };
}

/**
 * Escalating shutdown for repeated OS signals (Ctrl+C): the first call claims
 * and tears down gracefully; a second call skips the grace period and exits now
 * so a repeated Ctrl+C always wins. The /api/shutdown route must NOT use this,
 * since a duplicate API request is a no-op (beginShutdown + runShutdownTeardown)
 * rather than an escalation.
 */
export async function gracefulShutdown(reason: string): Promise<ShutdownResult> {
  if (!beginShutdown(reason)) {
    // Repeated signal: skip the grace period and exit now.
    liveExit(target.exitCode ?? 130);
    return { terminated: 0 };
  }
  return runShutdownTeardown();
}
