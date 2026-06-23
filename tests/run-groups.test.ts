import { describe, expect, it } from "vitest";

import { groupRunsByTask, rollUpRunStatus } from "../src/ui/features/runs/groups.ts";
import type { HarnessRun } from "../src/ui/app/types.ts";

function run(partial: Partial<HarnessRun> & Pick<HarnessRun, "id" | "taskId" | "status" | "startedAt">): HarnessRun {
  return {
    taskTitle: "Task",
    agent: "grok",
    artifacts: [],
    ...partial
  };
}

describe("run-groups", () => {
  it("groups runs by taskId and sorts groups by latest activity", () => {
    const groups = groupRunsByTask([
      run({ id: "r1", taskId: "a", status: "completed", startedAt: "2026-06-06T10:00:00.000Z" }),
      run({ id: "r2", taskId: "b", status: "completed", startedAt: "2026-06-06T11:00:00.000Z" }),
      run({ id: "r3", taskId: "a", status: "completed", startedAt: "2026-06-06T10:30:00.000Z" })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.taskId).toBe("b");
    expect(groups[1]?.taskId).toBe("a");
    expect(groups[1]?.runs.map((item) => item.id)).toEqual(["r3", "r1"]);
  });

  it("rolls up active statuses while keeping groups collapsed by default", () => {
    const groups = groupRunsByTask([
      run({ id: "r1", taskId: "a", status: "completed", startedAt: "2026-06-06T10:00:00.000Z" }),
      run({ id: "r2", taskId: "a", status: "running", startedAt: "2026-06-06T10:30:00.000Z" })
    ]);

    expect(rollUpRunStatus(groups[0]!.runs)).toBe("running");
    expect(groups[0]?.defaultExpanded).toBe(false);
  });

  it("keeps completed-only groups collapsed by default", () => {
    const groups = groupRunsByTask([
      run({ id: "r1", taskId: "a", status: "completed", startedAt: "2026-06-06T10:00:00.000Z" })
    ]);

    expect(groups[0]?.defaultExpanded).toBe(false);
    expect(groups[0]?.rollUpStatus).toBe("completed");
  });
});
