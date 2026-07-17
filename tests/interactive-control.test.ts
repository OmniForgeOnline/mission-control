import { afterEach, describe, expect, it } from "vitest";

import {
  beginInteractiveWait,
  completeInteractiveTurn,
  getInteractiveWait,
  listInteractiveWaits,
  resetInteractiveControlForTests
} from "../src/terminal/interactive-control.ts";

describe("interactive turn control", () => {
  afterEach(() => {
    resetInteractiveControlForTests();
  });

  it("waits until the operator completes with done", async () => {
    const pending = beginInteractiveWait("task-1", {
      terminalSessionId: "term_abc",
      runId: "run-1"
    });
    expect(getInteractiveWait("task-1")?.terminalSessionId).toBe("term_abc");
    expect(listInteractiveWaits()).toHaveLength(1);

    const ok = completeInteractiveTurn("task-1", { kind: "done", note: "shipped" });
    expect(ok).toBe(true);

    await expect(pending).resolves.toEqual({ kind: "done", note: "shipped" });
    expect(getInteractiveWait("task-1")).toBeUndefined();
  });

  it("rejects complete when no waiter is registered", () => {
    expect(completeInteractiveTurn("missing", { kind: "blocked" })).toBe(false);
  });

  it("replaces an existing waiter for the same task", async () => {
    const first = beginInteractiveWait("task-2", { terminalSessionId: "term_old" });
    const second = beginInteractiveWait("task-2", { terminalSessionId: "term_new" });

    // First waiter is aborted by replacement.
    await expect(first).resolves.toEqual({
      kind: "aborted",
      note: "Superseded by a new interactive session"
    });

    completeInteractiveTurn("task-2", { kind: "done" });
    await expect(second).resolves.toEqual({ kind: "done" });
  });
});
