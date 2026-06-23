import { describe, expect, it, beforeEach } from "vitest";

import {
  abortAllInflightTurns,
  abortInflightTurn,
  clearInflightTurn,
  listInflightTaskIds,
  registerInflightTurn
} from "../src/runtime/sessions.ts";
import { computeQualityGrades } from "../src/core/quality/quality.ts";
import type { AgentRunner } from "../src/runners/types.ts";

class MockRunner implements AgentRunner {
  agent = "codex" as const;
  aborted = false;

  abort(): void {
    this.aborted = true;
  }

  runTurn(): Promise<never> {
    return new Promise(() => {});
  }
}

describe("runtime sessions", () => {
  beforeEach(() => {
    abortAllInflightTurns();
  });

  it("tracks inflight turns by task id", () => {
    const runner = new MockRunner();
    registerInflightTurn("task-1", runner);
    expect(listInflightTaskIds()).toEqual(["task-1"]);
  });

  it("clears inflight turns", () => {
    registerInflightTurn("task-1", new MockRunner());
    clearInflightTurn("task-1");
    expect(listInflightTaskIds()).toEqual([]);
  });

  it("aborts a registered runner and removes it from the map", () => {
    const runner = new MockRunner();
    registerInflightTurn("task-1", runner);
    expect(abortInflightTurn("task-1")).toBe(true);
    expect(runner.aborted).toBe(true);
    expect(listInflightTaskIds()).toEqual([]);
  });

  it("returns false when aborting an absent task", () => {
    expect(abortInflightTurn("missing")).toBe(false);
  });

  it("aborts all inflight runners and clears the map", () => {
    const first = new MockRunner();
    const second = new MockRunner();
    registerInflightTurn("task-1", first);
    registerInflightTurn("task-2", second);
    abortAllInflightTurns();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
    expect(listInflightTaskIds()).toEqual([]);
  });

  it("replaces the runner when the same task registers again", () => {
    const first = new MockRunner();
    const second = new MockRunner();
    registerInflightTurn("task-1", first);
    registerInflightTurn("task-1", second);
    expect(listInflightTaskIds()).toEqual(["task-1"]);
    expect(abortInflightTurn("task-1")).toBe(true);
    expect(second.aborted).toBe(true);
    expect(first.aborted).toBe(false);
  });

  it("does not clear a newer inflight run when an older duplicate finishes", () => {
    const first = new MockRunner();
    const second = new MockRunner();
    registerInflightTurn("task-1", first, "run-1");
    registerInflightTurn("task-1", second, "run-2");

    clearInflightTurn("task-1", "run-1");

    expect(listInflightTaskIds()).toEqual(["task-1"]);
    expect(abortInflightTurn("task-1")).toBe(true);
    expect(second.aborted).toBe(true);
    expect(first.aborted).toBe(false);
  });
});

describe("runtime quality grade", () => {
  it("grades the runtime domain A when tests/runtime.test.ts exists", async () => {
    const quality = await computeQualityGrades(process.cwd());
    expect(quality.domains['runtime']?.grade).toBe("A");
    expect(quality.domains['runtime']?.rationale).toBe(
      "Healthy: no oversized files, tests reference this domain."
    );
  });
});
