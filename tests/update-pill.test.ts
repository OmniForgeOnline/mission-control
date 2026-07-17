import { describe, expect, it } from "vitest";

import { awaitServerRestart, updatePillModel, type VersionStatus } from "../src/ui/shell/update-pill.ts";

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
// the next queued reachability value, holding the last one once the queue drains.
function watchHarness(probeResults: boolean[]) {
  let idx = 0;
  let clock = 0;
  const events: string[] = [];
  const deps = {
    probe: async (): Promise<boolean> => {
      const up = probeResults[Math.min(idx++, probeResults.length - 1)] ?? false;
      events.push(`probe=${up}`);
      return up;
    },
    sleep: async (): Promise<void> => {
      events.push("sleep");
    },
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

describe("awaitServerRestart", () => {
  it("reloads once the server goes down and comes back", async () => {
    // old server still up briefly, then restarting (down), then back up (new version)
    const { deps, events } = watchHarness([true, false, true, true]);
    await awaitServerRestart(deps, 1, 10_000);
    expect(events).toContain("reload");
    expect(events).not.toContain("timeout");
  });

  it("falls back to onTimeout when the server never restarts", async () => {
    const { deps, events } = watchHarness([true]);
    await awaitServerRestart(deps, 1, 10_000);
    expect(events).toContain("timeout");
    expect(events).not.toContain("reload");
  });

  it("falls back to onTimeout when the server goes down but never returns", async () => {
    const { deps, events } = watchHarness([false]);
    await awaitServerRestart(deps, 1, 10_000);
    expect(events).toContain("timeout");
    expect(events).not.toContain("reload");
  });
});
