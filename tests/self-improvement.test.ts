import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildSelfImprovementContext,
  buildSelfImprovementPrompt,
  runHarnessSelfImprovement,
  SELF_IMPROVEMENT_STALE_LOCK_MS,
  SELF_IMPROVEMENT_TASK_ID
} from "../src/autonomy/self-improvement.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createRun, listRuns } from "../src/core/tasks/runs.ts";
import { listTasks } from "../src/core/tasks/tasks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { AgentRunner } from "../src/runners/types.ts";

describe("harness self-improvement", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-self-improve-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a prompt that instructs the agent to investigate and propose", async () => {
    const context = await buildSelfImprovementContext(root);
    const prompt = buildSelfImprovementPrompt(context);

    expect(prompt).toContain("self-improvement agent");
    expect(prompt).toContain("propose_rule");
    expect(prompt).toContain("Recent harness snapshot");
    expect(prompt).toContain(context);
    expect(prompt).toContain("Do NOT file duplicate");
  });

  it("runs a scheduled self-improvement turn and records a run artifact", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      "Reviewed recent tasks. Filed one proposal for workflow advancement after push.\n\n**Next.** Operator: review the pending proposal."
    ]);

    const result = await runHarnessSelfImprovement(root, { runner });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("proposal");

    const runs = await listRuns(root);
    expect(runs[0]?.taskTitle).toBe("Harness self-improvement");
    await expect(readFile(path.join(root, "data", "runs", result.runId, "summary.md"), "utf8")).resolves.toContain(
      "workflow advancement"
    );
  });

  it("resumes the self-improvement session across scheduled runs", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["First scheduled review.", "Second scheduled review."]);

    await runHarnessSelfImprovement(root, { runner });
    const second = await runHarnessSelfImprovement(root, { runner });

    expect(second.status).toBe("completed");
    const state = JSON.parse(
      await readFile(path.join(root, "data", "state", "self-improvement.json"), "utf8")
    );
    expect(state.turnCount).toBe(2);
    expect(state.runningSince).toBeUndefined();
  });

  it("skips when runningSince is fresh without spawning an agent", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["Should not run."]);
    let turnCount = 0;
    const countingRunner: AgentRunner = {
      agent: runner.agent,
      abort: () => runner.abort(),
      runTurn: async (request) => {
        turnCount += 1;
        return runner.runTurn(request);
      }
    };

    await writeJsonFile(path.join(root, "data", "state", "self-improvement.json"), {
      runningSince: new Date().toISOString()
    });

    const result = await runHarnessSelfImprovement(root, { runner: countingRunner });

    expect(result).toMatchObject({
      status: "completed",
      summary: "Self-improvement skipped: already running.",
      proposalsCreated: 0
    });
    expect(turnCount).toBe(0);
    expect(await listRuns(root)).toHaveLength(0);
  });

  it("skips when a self-improvement run is already running", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["Should not run."]);
    let turnCount = 0;
    const countingRunner: AgentRunner = {
      agent: runner.agent,
      abort: () => runner.abort(),
      runTurn: async (request) => {
        turnCount += 1;
        return runner.runTurn(request);
      }
    };

    const activeRun = await createRun(root, {
      taskId: SELF_IMPROVEMENT_TASK_ID,
      taskTitle: "Harness self-improvement",
      agent: "grok",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });

    const result = await runHarnessSelfImprovement(root, { runner: countingRunner });

    expect(result).toMatchObject({
      status: "completed",
      summary: "Self-improvement skipped: already running.",
      proposalsCreated: 0,
      runId: activeRun.id
    });
    expect(turnCount).toBe(0);
    expect(await listRuns(root)).toHaveLength(1);
  });

  it("proceeds when runningSince is stale", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["Stale guard cleared."]);

    const staleSince = new Date(Date.now() - SELF_IMPROVEMENT_STALE_LOCK_MS - 60_000).toISOString();
    await writeJsonFile(path.join(root, "data", "state", "self-improvement.json"), {
      runningSince: staleSince
    });

    const result = await runHarnessSelfImprovement(root, { runner });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("completed");
    const state = JSON.parse(
      await readFile(path.join(root, "data", "state", "self-improvement.json"), "utf8")
    );
    expect(state.runningSince).toBeUndefined();
  });

  it("clears runningSince after a completed turn", async () => {
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["Done."]);

    await runHarnessSelfImprovement(root, { runner });

    const state = JSON.parse(
      await readFile(path.join(root, "data", "state", "self-improvement.json"), "utf8")
    );
    expect(state.runningSince).toBeUndefined();
  });

  it("clears runningSince after a blocked turn", async () => {
    const blockedRunner: AgentRunner = {
      agent: "grok",
      abort() {},
      async runTurn() {
        return {
          reply: "",
          sessionId: "blocked-session",
          exitCode: 1,
          command: "blocked",
          blockedReason: "test blocked",
          rawLog: ""
        };
      }
    };

    const result = await runHarnessSelfImprovement(root, { runner: blockedRunner });

    expect(result.status).toBe("blocked");
    const state = JSON.parse(
      await readFile(path.join(root, "data", "state", "self-improvement.json"), "utf8")
    );
    expect(state.runningSince).toBeUndefined();
  });

  it("enriches snapshot from runs and autonomy state when tasks.json is empty", async () => {
    await writeJsonFile(path.join(root, "data", "state", "tasks.json"), []);

    const runIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const run = await createRun(root, {
        taskId: `deleted-task-${index}`,
        taskTitle: `Completed task ${index}`,
        agent: "grok",
        status: index === 2 ? "blocked" : "completed",
        startedAt: new Date(Date.now() - index * 60_000).toISOString(),
        completedAt: new Date(Date.now() - index * 60_000 + 30_000).toISOString(),
        artifacts: []
      });
      runIds.push(run.id);
    }

    await writeJsonFile(path.join(root, "data", "state", "autonomy-runs.json"), [
      {
        jobId: "worktree-cleanup-sweep",
        status: "completed",
        summary: "Removed 6 merged worktrees.",
        proposalsCreated: 0
      },
      {
        jobId: "harness-guidance-sweep",
        status: "completed",
        summary: "Filed 4 guidance proposals.",
        proposalsCreated: 4
      },
      {
        jobId: "operational-error-triage",
        status: "blocked",
        summary: "Runtime gate blocked then recovered.",
        proposalsCreated: 0
      }
    ]);

    await writeJsonFile(path.join(root, "data", "state", "autonomy-jobs.json"), [
      {
        id: "worktree-cleanup-sweep",
        title: "Worktree cleanup sweep",
        description: "Remove isolated git worktrees after their merge requests have been merged.",
        schedule: "every-1h",
        status: "active",
        runMode: "automatic",
        approvalPolicy: "read-only",
        lastSummary: "Removed 6 merged worktrees."
      },
      {
        id: "workflow-reconcile-sweep",
        title: "Workflow reconcile sweep",
        description: "Scan repo-backed tasks stuck after push on pre-review workflow steps and chain workflow advancement.",
        schedule: "every-1h",
        status: "active",
        runMode: "automatic",
        approvalPolicy: "read-only",
        lastSummary: "Advanced 3 stuck tasks."
      },
      {
        id: "clickup-ticket-sync",
        title: "ClickUp ticket sync",
        description: "Poll subscribed ClickUp lists for @omc tickets and mirror harness lifecycle updates upstream.",
        schedule: "every-5m",
        status: "paused",
        runMode: "automatic",
        approvalPolicy: "synthetic-task",
        lastSummary: "Synced 2 tickets."
      }
    ]);

    const context = await buildSelfImprovementContext(root);

    expect(context).toContain("Recent tasks:\n- none");
    expect(context).not.toContain("Recent runs:\n- none");
    expect(context).toContain(runIds[0]!.slice(0, 8));
    expect(context).toContain("Completed task 0");
    expect(context).toContain("blocked");
    expect(context).toContain("Recent autonomy runs:");
    expect(context).toContain("worktree-cleanup-sweep · Removed 6 merged worktrees.");
    expect(context).toContain("harness-guidance-sweep · Filed 4 guidance proposals.");
    expect(context).toContain("operational-error-triage · Runtime gate blocked then recovered.");
    expect(context).toContain("Autonomy job highlights:");
    expect(context).toContain("worktree-cleanup-sweep: Removed 6 merged worktrees.");
    expect(context).toContain("workflow-reconcile-sweep: Advanced 3 stuck tasks.");
    expect(context).toContain("clickup-ticket-sync: Synced 2 tickets.");
  });

  it("keeps task count stable when an invocation is skipped", async () => {
    const tasksBefore = (await listTasks(root)).length;
    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["Should not run."]);

    await writeJsonFile(path.join(root, "data", "state", "self-improvement.json"), {
      runningSince: new Date().toISOString()
    });

    const skipped = await runHarnessSelfImprovement(root, { runner });

    expect(skipped.summary).toBe("Self-improvement skipped: already running.");
    expect((await listTasks(root)).length).toBe(tasksBefore);
  });
});