import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { looksLikeFinalAnswer, processAllApprovedTasks, processNextApprovedTask } from "../src/daemon/processor.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { approveTask, createTask, getTask, setTaskStatus, updateTask } from "../src/core/tasks/tasks.ts";
import { cleanRuns, createRun, listRuns } from "../src/core/tasks/runs.ts";
import { resolveStepRouting } from "../src/core/agents/stage-agents.ts";
import { loadAgentConfig } from "../src/core/agents/config/store.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import type { AgentActivity, AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";

/**
 * Poll the task until `predicate` holds or the timeout elapses. Used to observe
 * state written by a fire-and-forget turn without racing on a fixed sleep.
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

describe("daemon processor", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-daemon-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs one approved task with a deterministic runner and records artifacts", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Review deployment plan",
      description: "Find risks before implementation.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });

    const updated = await getTask(root, task.id);
    expect(result?.execution).toBeDefined();
    expect(updated?.runId).toBe(result?.runId);
    expect(updated?.turnCount).toBe(1);
    expect(updated?.messages?.some((m) => m.author === "agent")).toBe(true);
    await expect(readFile(path.join(root, "data", "runs", result!.runId, "summary.md"), "utf8")).resolves.toContain(
      "Deterministic codex reply"
    );
  });

  it("persists the resolved model pool id on the agent run", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Surface model",
      description: "The run record should carry the resolved model pool.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });

    const runs = await listRuns(root);
    const run = runs.find((entry) => entry.id === result?.runId);
    expect(run).toBeDefined();

    // Captured from the real resolution path: the pool recorded on the run must
    // match what routing resolves for the step that executed ...
    const workflowId = task.workflowRun!.workflowId;
    const stepId = task.workflowRun!.currentStepId;
    const routing = await resolveStepRouting(root, workflowId, stepId);
    expect(routing?.modelPoolId).toBeTruthy();
    expect(run!.modelPoolId).toBe(routing!.modelPoolId);

    // ... and that pool must belong to the agent that actually ran the turn.
    const bundle = await loadAgentConfig(root);
    const pool = bundle.pools.find((entry) => entry.id === run!.modelPoolId);
    expect(pool?.toolId).toBe(run!.agent);

    // The run records which step executed it, so the UI can surface the model
    // for completed steps after the workflow advances past them.
    expect(run!.stepId).toBe(stepId);
  });

  it("does not execute queued tasks until they are approved", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Unapproved task",
      description: "Should stay queued.",
      source: "manual",
      links: []
    });
    await updateTask(root, task.id, (current) => ({
      ...current,
      workflowRun: {
        ...current.workflowRun!,
        currentStepId: "plan_gate"
      }
    }));

    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("claude"), wait: true });

    expect(result).toBeNull();
  });

  it("sets runId and a live activity on the task while the turn is in flight", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Long task",
      description: "Takes a moment.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    // Runner that reports an activity then blocks until we release it, so we can
    // observe the task's mid-flight state.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: AgentRunner = {
      agent: "codex",
      abort() {},
      async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
        request.onActivity?.({ label: "running tests", at: new Date().toISOString() } satisfies AgentActivity);
        await gate;
        return {
          reply: "done",
          sessionId: "sess-1",
          exitCode: 0,
          command: "codex test",
          rawLog: ""
        };
      }
    };

    // Fire-and-forget (wait: false) so we can inspect state during the turn.
    const summary = await processNextApprovedTask(root, { runner, wait: false });
    expect(summary?.execution).toBe("running");

    const midFlight = await getTask(root, task.id);
    expect(midFlight && (await taskLegacyStatus(root, midFlight))).toBe("running");
    expect(midFlight?.runId).toBe(summary?.runId);

    release();

    // The turn completes asynchronously (fire-and-forget). Poll until the
    // final state is persisted instead of guessing at a fixed delay: turnCount
    // and the cleared currentActivity are written together in the same update.
    const finished = await waitForTask(root, task.id, (t) => t.turnCount === 1);
    expect(finished?.runId).toBe(summary?.runId);
    expect(finished?.currentActivity).toBeUndefined();
    expect(finished?.turnCount).toBe(1);
  });

  it("preserves an in-flight run when cleaning historical runs", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Clean while running",
      description: "A run cleanup should not delete the active turn.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: AgentRunner = {
      agent: "codex",
      abort() {},
      async runTurn(): Promise<AgentTurnResult> {
        await gate;
        return {
          reply: "done",
          exitCode: 0,
          command: "codex test",
          rawLog: ""
        };
      }
    };

    const summary = await processNextApprovedTask(root, { runner, wait: false });
    expect(summary?.execution).toBe("running");

    const clean = await cleanRuns(root);
    expect(clean.deleted).toBe(0);
    expect((await listRuns(root)).map((run) => run.id)).toContain(summary!.runId);

    release();

    const finished = await waitForTask(root, task.id, (t) => t.turnCount === 1);
    expect(finished?.runId).toBe(summary?.runId);
    expect(finished?.turnCount).toBe(1);
  });

  it("does not dispatch a task that already has a persisted running run", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Already running",
      description: "The harness restarted with an active run on disk.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);
    const run = await createRun(root, {
      taskId: task.id,
      taskTitle: task.title,
      agent: "codex",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: ["prompt.md", "log.txt"]
    });
    await updateTask(root, task.id, (current) => ({
      ...current,
      runId: run.id,
      startedAt: run.startedAt,
      updatedAt: new Date().toISOString()
    }));

    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });

    expect(result).toBeNull();
    const unchanged = await getTask(root, task.id);
    expect(unchanged?.runId).toBe(run.id);
    expect(unchanged?.turnCount).toBeUndefined();
  });

  it("does not auto-pick awaiting_operator tasks", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Waiting for operator",
      description: "Should not be re-picked by the daemon.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);
    // Run one turn so the task lands in awaiting_operator.
    await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });

    const afterFirstTurn = await getTask(root, task.id);
    expect(afterFirstTurn && (await taskLegacyStatus(root, afterFirstTurn))).toBe("awaiting_operator");

    // Daemon should NOT pick it up again.
    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });
    expect(result).toBeNull();

    const unchanged = await getTask(root, task.id);
    expect(unchanged?.turnCount).toBe(1);
  });

  it("does not auto-pick awaiting_review tasks", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Under review",
      description: "Should not be re-picked by the daemon.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);
    // Simulate a task that landed in awaiting_review.
    await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });
    await setTaskStatus(root, task.id, "awaiting_review");

    const result = await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });
    expect(result).toBeNull();
  });

  it("processAllApprovedTasks skips awaiting_operator tasks", async () => {
    await ensureHarnessRepository(root);
    const task = await createTask(root, {
      title: "Waiting for operator",
      description: "Batch test.",
      agent: "codex",
      source: "manual",
      links: []
    });
    await approveTask(root, task.id);
    await processNextApprovedTask(root, { runner: new DeterministicAgentRunner("codex"), wait: true });

    const afterFirstTurn = await getTask(root, task.id);
    expect(afterFirstTurn && (await taskLegacyStatus(root, afterFirstTurn))).toBe("awaiting_operator");

    const results = await processAllApprovedTasks(root, { runner: new DeterministicAgentRunner("codex"), wait: true });
    expect(results).toHaveLength(0);
  });
});

describe("looksLikeFinalAnswer", () => {
  it("matches clear final statements", () => {
    expect(looksLikeFinalAnswer("The fix is done.")).toBe(true);
    expect(looksLikeFinalAnswer("Task completed successfully.")).toBe(true);
    expect(looksLikeFinalAnswer("Changes have been shipped.")).toBe(true);
    expect(looksLikeFinalAnswer("No further action needed.")).toBe(true);
  });

  it("rejects questions", () => {
    expect(looksLikeFinalAnswer("Is this what you wanted?")).toBe(false);
    expect(looksLikeFinalAnswer("Please confirm the approach.")).toBe(false);
  });

  it("rejects agent offering choices rather than declaring done", () => {
    expect(looksLikeFinalAnswer("The fix is complete. Ready to ship or happy to adjust if you'd like a different approach.")).toBe(false);
    expect(looksLikeFinalAnswer("Done. Let me know if you'd like changes or if I should ship.")).toBe(false);
    expect(looksLikeFinalAnswer("Ready to ship, but can adjust if needed.")).toBe(false);
  });

  it("accepts genuine done+ship statements", () => {
    expect(looksLikeFinalAnswer("Fix shipped. All tests pass.")).toBe(true);
    expect(looksLikeFinalAnswer("The changes are done and pushed.")).toBe(true);
  });

  it("accepts operator-handoff sections without done/shipped keywords", () => {
    expect(looksLikeFinalAnswer("**Pushed.** harness/abc123 · 1 commit(s) · add tests/core.test.ts.")).toBe(true);
    expect(looksLikeFinalAnswer("**Changed.** tests/core.test.ts")).toBe(true);
  });

  it("returns false on empty input", () => {
    expect(looksLikeFinalAnswer("")).toBe(false);
  });
});
