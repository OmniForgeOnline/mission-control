import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AUTONOMY_AGENT_STALE_LOCK_MS } from "../src/autonomy/agent-run.ts";
import {
  EVOLUTION_REVIEW_TASK_ID,
  buildEvolutionReviewContext,
  buildEvolutionReviewPrompt,
  runTurnEvolutionReview
} from "../src/autonomy/evolution-review.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createRun, listRuns } from "../src/core/tasks/runs.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { AgentRunner } from "../src/runners/types.ts";

describe("turn evolution review", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-evo-review-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a prompt that instructs the agent to find cross-run patterns", async () => {
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Fix MCP tests",
      agent: "grok",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifacts: ["summary.md"]
    });
    const runDir = path.join(root, "data", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "summary.md"),
      "Parallel vitest runs race on shared execFileMock. Serialize those tests.\n",
      "utf8"
    );

    const context = await buildEvolutionReviewContext(root);
    const prompt = buildEvolutionReviewPrompt(context);

    expect(prompt).toContain("cross-run patterns");
    expect(prompt).toContain("propose_skill");
    expect(prompt).toContain(run.id.slice(0, 8));
    expect(context).toContain("Fix MCP tests");
  });

  it("exits early when there are no unreviewed completed runs", async () => {
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

    const result = await runTurnEvolutionReview(root, { runner: countingRunner });

    expect(result.summary).toBe("No unreviewed completed runs.");
    expect(turnCount).toBe(0);
    expect(await listRuns(root)).toHaveLength(0);
  });

  it("runs an agent turn and marks runs reviewed afterward", async () => {
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Workflow fix",
      agent: "grok",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifacts: ["summary.md"]
    });
    const runDir = path.join(root, "data", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "summary.md"), "Tasks stall after push when mergeRequest is missing.\n", "utf8");

    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies([
      "Reviewed 1 run. Found a post-push stall pattern. Filed propose_skill for debug-prior-runs."
    ]);

    const result = await runTurnEvolutionReview(root, { runner });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Evolution review turn 1 completed");

    const reviewed = JSON.parse(
      await readFile(path.join(root, "data", "state", "evolution-reviewed.json"), "utf8")
    );
    expect(reviewed).toEqual([{ runId: run.id, reviewedAt: expect.any(String) }]);
  });

  it("skips when already running", async () => {
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
      taskId: EVOLUTION_REVIEW_TASK_ID,
      taskTitle: "Turn evolution review",
      agent: "grok",
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: []
    });

    const result = await runTurnEvolutionReview(root, { runner: countingRunner });

    expect(result).toMatchObject({
      status: "completed",
      summary: "Evolution review skipped: already running.",
      proposalsCreated: 0,
      runId: activeRun.id
    });
    expect(turnCount).toBe(0);
  });

  it("proceeds when runningSince is stale", async () => {
    const run = await createRun(root, {
      taskId: "task-1",
      taskTitle: "Stale guard",
      agent: "grok",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifacts: ["summary.md"]
    });
    const runDir = path.join(root, "data", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "summary.md"), "Done.\n", "utf8");

    const runner = new DeterministicAgentRunner("grok");
    runner.setReplies(["Stale guard cleared."]);

    const staleSince = new Date(Date.now() - AUTONOMY_AGENT_STALE_LOCK_MS - 60_000).toISOString();
    await writeJsonFile(path.join(root, "data", "state", "evolution-review.json"), {
      runningSince: staleSince
    });

    const result = await runTurnEvolutionReview(root, { runner });

    expect(result.status).toBe("completed");
    const state = JSON.parse(
      await readFile(path.join(root, "data", "state", "evolution-review.json"), "utf8")
    );
    expect(state.runningSince).toBeUndefined();
  });
});