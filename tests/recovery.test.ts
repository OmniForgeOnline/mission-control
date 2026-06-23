import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processNextApprovedTask, resumeTask, runTaskTurn } from "../src/daemon/processor.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { approveTask, createTask, getTask, setTaskStatus, updateTask } from "../src/core/tasks/tasks.ts";
import { createRun, listRuns } from "../src/core/tasks/runs.ts";
import { reconcileInterruptedTasks } from "../src/core/bootstrap/reconciliation.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";

/**
 * Poll the task until `predicate` holds or the timeout elapses.
 */
async function waitForTask(
  root: string,
  taskId: string,
  predicate: (task: NonNullable<Awaited<ReturnType<typeof getTask>>>) => boolean,
  timeoutMs = 2000
): Promise<Awaited<ReturnType<typeof getTask>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(root, taskId);
    if (task && predicate(task)) return task;
    if (Date.now() >= deadline) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("task recovery: interrupted, paused, resume", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-recovery-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reconciles orphaned running tasks as interrupted at boot", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Crashed task",
      description: "Was running when harness died.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    // Simulate mid-turn crash: task in running, run in running.
    const run = await createRun(root, {
      taskId: task.id,
      taskTitle: task.title,
      agent: "claude",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    await setTaskStatus(root, task.id, "running", {
      runId: run.id,
      currentActivity: "editing files",
      lastProgressAt: new Date().toISOString()
    });

    const result = await reconcileInterruptedTasks(root);
    expect(result.reconciled).toBe(1);

    const reconciled = await getTask(root, task.id);
    expect(reconciled && (await taskLegacyStatus(root, reconciled))).toBe("interrupted");
    expect(reconciled?.currentActivity).toBeUndefined();
    expect(reconciled?.runId).toBe(run.id);

    const runs = await listRuns(root);
    expect(runs.find((r) => r.id === run.id)?.status).toBe("interrupted");
  });

  it("reconciles duplicate orphaned running runs for the same task", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Duplicated task",
      description: "Multiple runs were launched before restart.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);
    const first = await createRun(root, {
      taskId: task.id,
      taskTitle: task.title,
      agent: "claude",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    const second = await createRun(root, {
      taskId: task.id,
      taskTitle: task.title,
      agent: "claude",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    await setTaskStatus(root, task.id, "running", {
      runId: second.id,
      currentActivity: "editing files",
      lastProgressAt: new Date().toISOString()
    });

    const result = await reconcileInterruptedTasks(root);

    expect(result.reconciled).toBe(1);
    const runs = await listRuns(root);
    expect(runs.find((r) => r.id === first.id)?.status).toBe("interrupted");
    expect(runs.find((r) => r.id === second.id)?.status).toBe("interrupted");
  });

  it("does not auto-resume interrupted tasks", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Interrupted task",
      description: "Should not auto-resume.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);
    await setTaskStatus(root, task.id, "interrupted");

    const result = await processNextApprovedTask(root, {
      runner: new DeterministicAgentRunner("claude"),
      wait: true
    });

    expect(result).toBeNull();
    const unchanged = await getTask(root, task.id);
    expect(unchanged && (await taskLegacyStatus(root, unchanged))).toBe("interrupted");
  });

  it("does not auto-resume paused tasks", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Paused task",
      description: "Operator stopped this.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);
    await setTaskStatus(root, task.id, "paused");

    const result = await processNextApprovedTask(root, {
      runner: new DeterministicAgentRunner("claude"),
      wait: true
    });

    expect(result).toBeNull();
    const unchanged = await getTask(root, task.id);
    expect(unchanged && (await taskLegacyStatus(root, unchanged))).toBe("paused");
  });

  it("blocks a task after exceeding the resume attempt cap", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Failing task",
      description: "Always fails on resume.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    // Simulate 3 previous failed resume attempts.
    await updateTask(root, task.id, (t) => ({
      ...t,
      interruptedAt: new Date().toISOString(),
      resumeAttempts: 3
    }));

    const result = await resumeTask(root, task.id, {
      runner: new DeterministicAgentRunner("claude"),
      wait: true
    });

    expect(result).toBeNull();
    const blocked = await getTask(root, task.id);
    expect(blocked && (await taskLegacyStatus(root, blocked))).toBe("blocked");
    expect(blocked?.blockedReason).toContain("resume attempts");
  });

  it("sets paused (not blocked) when an operator kills a running task", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Killable task",
      description: "Will be killed.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    const abortedRunner: AgentRunner = {
      agent: "claude",
      abort() {},
      async runTurn(): Promise<AgentTurnResult> {
        return {
          reply: "",
          sessionId: "sess-abort",
          exitCode: 1,
          command: "claude abort",
          rawLog: "",
          blockedReason: "Stopped by operator"
        };
      }
    };

    await runTaskTurn(root, task.id, { runner: abortedRunner, wait: true });

    const killed = await getTask(root, task.id);
    expect(killed && (await taskLegacyStatus(root, killed))).toBe("paused");
    expect(killed?.currentActivity).toBeUndefined();
  });

  it("persists agentSessionId mid-turn via onSessionId callback", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Session test",
      description: "Track session persistence.",
      agent: "claude",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const gatedRunner: AgentRunner = {
      agent: "claude",
      abort() {},
      async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
        // Fire the session id callback mid-turn.
        request.onSessionId?.("mid-turn-session-123");
        await gate;
        return {
          reply: "done",
          sessionId: "mid-turn-session-123",
          exitCode: 0,
          command: "claude test",
          rawLog: ""
        };
      }
    };

    // Fire-and-forget so we can observe mid-turn state.
    await runTaskTurn(root, task.id, { runner: gatedRunner, wait: false });

    // Wait for the session id callback to fire and be persisted.
    const midTurn = await waitForTask(
      root,
      task.id,
      (t) => t.agentSessionId === "mid-turn-session-123",
      2000
    );
    expect(midTurn?.agentSessionId).toBe("mid-turn-session-123");
    // Task should still be running (gate not released yet).
    expect(midTurn && (await taskLegacyStatus(root, midTurn))).toBe("running");

    release();

    const finished = await waitForTask(root, task.id, (t) => t.turnCount === 1);
    expect(finished?.turnCount).toBe(1);
  });
});
