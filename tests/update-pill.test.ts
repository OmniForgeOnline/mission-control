import { describe, expect, it } from "vitest";

import {
  awaitServerRestart,
  updatePillModel,
  type RestartWatcherDeps,
  type VersionStatus
} from "../src/ui/shell/update-pill.ts";

function status(overrides: Partial<VersionStatus> = {}): VersionStatus {
  return {
    installed: "0.1.3",
    latest: "0.1.4",
    behind: true,
    fetchedAt: "2026-06-29T00:00:00.000Z",
    canSelfUpdate: true,
    lastUpdate: null,
    ...overrides
  };
}

describe("updatePillModel", () => {
  it("is hidden when there is no status yet", () => {
    expect(updatePillModel(null).visible).toBe(false);
  });

  it("is hidden when the install is current", () => {
    expect(updatePillModel(status({ behind: false })).visible).toBe(false);
  });

  it("is visible when behind and exposes the target version", () => {
    const model = updatePillModel(status({ behind: true, latest: "0.1.4" }));
    expect(model.visible).toBe(true);
    expect(model.latest).toBe("0.1.4");
    expect(model.canSelfUpdate).toBe(true);
  });
});

// Fake clock + probe harness for the restart watcher. `now()` advances a fixed
// step on every call so the loop terminates without real timers; `probe` reads
// the next queued version status (or null for an unreachable server), holding
// the last one once the queue drains.
function restartHarness(results: (VersionStatus | null)[]) {
  let idx = 0;
  let clock = 0;
  const events: string[] = [];
  const deps: RestartWatcherDeps = {
    probe: async (): Promise<VersionStatus | null> =>
      results[Math.min(idx++, results.length - 1)] ?? null,
    sleep: async (): Promise<void> => {},
    now: (): number => {
      const t = clock;
      clock += 1000;
      return t;
    },
    reload: (): void => {
      events.push("reload");
    },
    onTimeout: (): void => {
      events.push("timeout");
    }
  };
  return { deps, events };
}

const BEHIND = status();
const DONE = status({
  installed: "0.1.4",
  behind: false,
  lastUpdate: { result: "ok", from: "0.1.3", to: "0.1.4", at: "2026-07-17T00:00:01.000Z" }
});
const FAILED = status({
  lastUpdate: {
    result: "failed",
    from: "0.1.3",
    to: null,
    at: "2026-07-17T00:00:02.000Z",
    message: "npm install failed"
  }
});

describe("awaitServerRestart", () => {
  it("reloads on a fresh successful outcome without ever observing downtime", async () => {
    // Fast restart: every probe reaches the server, but a fresh ok outcome
    // appears once the new server is up. The outage-based watcher missed this.
    const { deps, events } = restartHarness([BEHIND, BEHIND, DONE]);
    await awaitServerRestart(deps, null, 1, 10_000);
    expect(events).toContain("reload");
    expect(events).not.toContain("timeout");
  });

  it("reloads when the server goes down and comes back with a fresh outcome", async () => {
    const { deps, events } = restartHarness([BEHIND, null, DONE]);
    await awaitServerRestart(deps, null, 1, 10_000);
    expect(events).toContain("reload");
    expect(events).not.toContain("timeout");
  });

  it("reloads on the first probe when the server is already back with a fresh outcome", async () => {
    // Baseline captured before the apply POST: even if the new server answers
    // the watcher's very first probe, that fresh outcome must count as "new"
    // rather than being mistaken for the baseline (the pre-fix timeout bug).
    const { deps, events } = restartHarness([DONE]);
    await awaitServerRestart(deps, null, 1, 10_000);
    expect(events).toContain("reload");
    expect(events).not.toContain("timeout");
  });

  it("reloads on a fresh failed outcome so the failure can surface", async () => {
    // A failed update still writes a fresh outcome; reload lets polling toast
    // the error instead of hanging on "Restarting..." until the deadline.
    const { deps, events } = restartHarness([BEHIND, FAILED]);
    await awaitServerRestart(deps, null, 1, 10_000);
    expect(events).toContain("reload");
    expect(events).not.toContain("timeout");
  });

  it("does not reload on a stale outcome already present before the update", async () => {
    // A pre-existing ok outcome must not trigger a reload before this update
    // completes; only a freshly written one (different `at`) should.
    const stale = status({ behind: false, lastUpdate: DONE.lastUpdate });
    const { deps, events } = restartHarness([stale]);
    await awaitServerRestart(deps, DONE.lastUpdate!.at, 1, 10_000);
    expect(events).toContain("timeout");
    expect(events).not.toContain("reload");
  });

  it("falls back to onTimeout when the server stays up but never completes", async () => {
    const { deps, events } = restartHarness([BEHIND]);
    await awaitServerRestart(deps, null, 1, 10_000);
    expect(events).toContain("timeout");
    expect(events).not.toContain("reload");
  });

  it("falls back to onTimeout when the server goes down and never returns", async () => {
    const { deps, events } = restartHarness([BEHIND, null]);
    await awaitServerRestart(deps, null, 1, 10_000);
    expect(events).toContain("timeout");
    expect(events).not.toContain("reload");
  });
});
