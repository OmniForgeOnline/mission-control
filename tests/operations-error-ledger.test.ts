import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  captureOperationalError,
  classifyBlockedReason,
  fingerprintOperationalError,
  listOpenOperationalErrors,
  listOperationalErrors,
  shouldCaptureOperationalError
} from "../src/core/operations/error-ledger.ts";
import { setTaskStatus } from "../src/core/tasks/tasks.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask } from "../src/core/tasks/tasks.ts";

describe("operational error ledger", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-op-errors-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classifies task-scoped validation failures separately from harness platform errors", () => {
    expect(classifyBlockedReason("Harness commit still failing after 3 rounds: eslint unused import")).toBe(
      "task_scoped"
    );
    expect(classifyBlockedReason("Mechanical checks still failing after 3 rounds")).toBe("task_scoped");
    expect(classifyBlockedReason("Merge request creation failed: connector auth missing")).toBe("harness_platform");
    expect(classifyBlockedReason("Exceeded maximum resume attempts (3)")).toBe("harness_platform");
  });

  it("deduplicates similar harness-platform errors within the capture window", async () => {
    const message = "Merge request creation failed: GitHub API 401";
    const first = await captureOperationalError(root, {
      message,
      taskId: "11111111-1111-1111-1111-111111111111",
      taskTitle: "Quality gate: runtime",
      workflowStep: "create_merge_request"
    });
    const second = await captureOperationalError(root, {
      message,
      taskId: "22222222-2222-2222-2222-222222222222",
      taskTitle: "Quality gate: runtime",
      workflowStep: "create_merge_request"
    });

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);
    expect((await listOperationalErrors(root))).toHaveLength(1);
  });

  it("does not capture task-scoped commit or lint failures", async () => {
    expect(
      await captureOperationalError(root, {
        message: "Command failed: git commit -m harness/abc: pre-commit: autofix eslint unused import",
        taskId: "11111111-1111-1111-1111-111111111111",
        taskTitle: "Quality gate: runtime",
        workflowStep: "implement"
      })
    ).toBeNull();
    expect(await listOpenOperationalErrors(root)).toHaveLength(0);
  });

  it("skips operator stops and autonomy task failures", () => {
    expect(
      shouldCaptureOperationalError({
        message: "Stopped by operator",
        taskId: "task-1"
      })
    ).toBe(false);
    expect(
      shouldCaptureOperationalError({
        message: "Merge request creation failed: timeout",
        taskId: "autonomy:harness-self-improvement"
      })
    ).toBe(false);
  });

  it("captures harness-platform blocked transitions via setTaskStatus", async () => {
    const task = await createTask(root, {
      title: "Broken workflow",
      description: "MR step failed.",
      source: "manual",
      links: []
    });

    await setTaskStatus(root, task.id, "blocked", {
      blockedReason: "Merge request creation failed: missing connector token",
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "create_merge_request",
        completedSteps: [],
        stepApprovals: {}
      }
    });

    // setTaskStatus records the error via a fire-and-forget async ledger write
    // (see patchTaskExecution). Poll the ledger until it lands instead of racing
    // a fixed timeout, which flakes under parallel-suite IO contention.
    let open = await listOpenOperationalErrors(root);
    for (let attempt = 0; attempt < 100 && open.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      open = await listOpenOperationalErrors(root);
    }
    expect(open).toHaveLength(1);
    expect(open[0]?.taskTitle).toBe("Broken workflow");
    expect(open[0]?.workflowStep).toBe("create_merge_request");
  });

  it("normalizes ids when fingerprinting", () => {
    const a = fingerprintOperationalError({
      message: "Merge request creation failed for task 11111111-1111-1111-1111-111111111111",
      taskTitle: "Quality gate: runtime",
      workflowStep: "create_merge_request"
    });
    const b = fingerprintOperationalError({
      message: "Merge request creation failed for task 22222222-2222-2222-2222-222222222222",
      taskTitle: "Quality gate: runtime",
      workflowStep: "create_merge_request"
    });
    expect(a).toBe(b);
  });
});