import { describe, expect, it, vi } from "vitest";

import { emitStateChange, onStateChange, taskScopes } from "../src/core/infra/state-bus.ts";

describe("state-bus", () => {
  it("notifies subscribers with task scopes", () => {
    const listener = vi.fn();
    const off = onStateChange(listener);

    emitStateChange(taskScopes("task-1"));

    expect(listener).toHaveBeenCalledWith(["chrome", "tasks", "task:task-1"]);
    off();
  });

  it("ignores empty scope lists", () => {
    const listener = vi.fn();
    onStateChange(listener);
    emitStateChange([]);
    expect(listener).not.toHaveBeenCalled();
  });
});