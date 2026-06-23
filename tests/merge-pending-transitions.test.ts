import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  advanceTaskWorkflowStep,
  createTask,
  getTask,
  markTaskCompleted,
  updateTask
} from "../src/core/tasks/tasks.ts";
import {
  deriveLegacyStatus,
  derivePmStatus,
  isMergePending,
  isTaskTerminal
} from "../src/core/tasks/status.ts";
import { createWorkflowRun } from "../src/core/workflows/run.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import type { HarnessTask, WorkflowRun } from "../src/core/types.ts";

// Reaching the terminal (handoff) step having completed every prior step.
const TERMINAL_COMPLETED = [
  "plan",
  "plan_gate",
  "implement",
  "checks",
  "create_merge_request",
  "review"
];

function terminalRun(): WorkflowRun {
  return {
    workflowId: "code-feature",
    currentStepId: "handoff",
    completedSteps: TERMINAL_COMPLETED,
    stepApprovals: {}
  };
}

function baseTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id: "t1",
    title: "Track merge state",
    description: "desc",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workflowRun: terminalRun(),
    ...overrides
  };
}

describe("merge-pending ticket transitions", () => {
  let root: string;
  let workflow: Awaited<ReturnType<typeof loadWorkflow>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-merge-pending-"));
    await ensureHarnessRepository(root);
    workflow = await loadWorkflow(root, "code-feature");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("isMergePending", () => {
    it("is pending while the MR/PR is open or closed-without-merge", () => {
      const open = baseTask({ mergeRequest: { provider: "github", url: "u", number: 1, state: "open" } });
      const closed = baseTask({ mergeRequest: { provider: "gitlab", url: "u", number: 2, state: "closed" } });
      expect(isMergePending(open)).toBe(true);
      expect(isMergePending(closed)).toBe(true);
    });

    it("is not pending once the MR/PR is merged, or when there is no MR/PR", () => {
      const merged = baseTask({
        mergeRequest: { provider: "github", url: "u", number: 1, state: "merged", mergedAt: "2026-01-02T00:00:00.000Z" }
      });
      const none = baseTask();
      expect(isMergePending(merged)).toBe(false);
      expect(isMergePending(none)).toBe(false);
    });
  });

  describe("terminal status derivation", () => {
    it("keeps a merge-pending terminal ticket in review, not done", () => {
      const task = baseTask({
        mergeRequest: { provider: "github", url: "u", number: 1, state: "open" }
      });
      // Terminal run records the handoff step as completed.
      task.workflowRun = { ...terminalRun(), completedSteps: [...TERMINAL_COMPLETED, "handoff"] };

      expect(isTaskTerminal(task, workflow)).toBe(true);
      expect(derivePmStatus(task, workflow)).toBe("in_review");
      expect(deriveLegacyStatus(task, workflow)).toBe("awaiting_review");
    });

    it("completes a terminal ticket once the MR/PR is merged", () => {
      const task = baseTask({
        resolution: "completed",
        completedAt: "2026-01-02T00:00:00.000Z",
        mergeRequest: { provider: "github", url: "u", number: 1, state: "merged", mergedAt: "2026-01-02T00:00:00.000Z" }
      });
      expect(derivePmStatus(task, workflow)).toBe("done");
      expect(deriveLegacyStatus(task, workflow)).toBe("completed");
    });

    it("completes a terminal ticket that has no MR/PR (non-repo work)", () => {
      const task = baseTask({
        resolution: "completed",
        completedAt: "2026-01-02T00:00:00.000Z"
      });
      expect(derivePmStatus(task, workflow)).toBe("done");
      expect(deriveLegacyStatus(task, workflow)).toBe("completed");
    });
  });

  async function taskAtHandoff(overrides: Partial<HarnessTask>): Promise<string> {
    const task = await createTask(root, {
      title: "Track merge state",
      description: "desc",
      workflowId: "code-feature",
      source: "manual"
    });
    await updateTask(root, task.id, (current) => ({
      ...current,
      workflowRun: terminalRun(),
      ...overrides
    }));
    return task.id;
  }

  describe("advanceTaskWorkflowStep at terminal handoff", () => {

    it("does not complete when an MR/PR is still open", async () => {
      const taskId = await taskAtHandoff({
        repoPath: "/tmp/repo",
        mergeRequest: { provider: "github", url: "https://github.com/acme/repo/pull/1", number: 1, state: "open" }
      });

      const updated = await advanceTaskWorkflowStep(root, taskId);
      expect(updated.workflowRun?.completedSteps).toContain("handoff");
      expect(updated.resolution).toBeUndefined();
      expect(updated.completedAt).toBeUndefined();

      const persisted = await getTask(root, taskId);
      expect(persisted?.resolution).toBeUndefined();
      expect(isMergePending(persisted!)).toBe(true);
    });

    it("completes when there is no MR/PR", async () => {
      const taskId = await taskAtHandoff({ repoPath: "/tmp/repo" });

      const updated = await advanceTaskWorkflowStep(root, taskId);
      expect(updated.resolution).toBe("completed");
      expect(updated.completedAt).toBeDefined();
    });
  });

  describe("markTaskCompleted at terminal handoff", () => {
    it("does not complete a merge-pending task; it stays awaiting merge", async () => {
      const taskId = await taskAtHandoff({
        repoPath: "/tmp/repo",
        mergeRequest: { provider: "github", url: "https://github.com/acme/repo/pull/1", number: 1, state: "open" }
      });

      const updated = await markTaskCompleted(root, taskId);
      expect(updated.resolution).toBeUndefined();
      expect(updated.completedAt).toBeUndefined();

      const persisted = await getTask(root, taskId);
      expect(persisted?.resolution).toBeUndefined();
      expect(persisted?.completedAt).toBeUndefined();
      expect(isMergePending(persisted!)).toBe(true);
    });

    it("completes a task once the MR/PR has merged", async () => {
      const taskId = await taskAtHandoff({
        repoPath: "/tmp/repo",
        mergeRequest: {
          provider: "github",
          url: "https://github.com/acme/repo/pull/1",
          number: 1,
          state: "merged",
          mergedAt: "2026-01-02T00:00:00.000Z"
        }
      });

      const updated = await markTaskCompleted(root, taskId);
      expect(updated.resolution).toBe("completed");
      expect(updated.completedAt).toBeDefined();
    });
  });

  it("createWorkflowRun starts at the first step (sanity for terminal construction)", () => {
    const run = createWorkflowRun(workflow);
    expect(run.completedSteps).toEqual([]);
    expect(run.currentStepId).not.toBe("handoff");
  });
});
