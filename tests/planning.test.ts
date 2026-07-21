import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { createServer } from "../src/server/app.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask } from "../src/core/tasks/tasks.ts";
import { processNextApprovedTask } from "../src/daemon/processor.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";

describe("planning as workflow step", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-planning-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not expose standalone planning routes", async () => {
    const app = createServer({ root, testMode: true });
    await request(app).post("/api/planning-sessions").send({ title: "X", agent: "claude" }).expect(404);
  });

  it("keeps planning interactive inside the ticket thread", async () => {
    const runner = new DeterministicAgentRunner("claude");
    runner.setReplies([
      "What constraints should the plan respect?",
      "<proposed_plan>\n# Plan\nShip workflow refactor.\n## Acceptance Criteria\nRefactor lands.\n## Verification\nRun tests.\n## Risks\nNone.\n</proposed_plan>",
      "<proposed_plan>\n# Plan\nShip workflow refactor with tests.\n## Acceptance Criteria\nRefactor lands.\n## Verification\nRun tests.\n## Risks\nNone.\n</proposed_plan>",
      "unused"
    ]);

    const task = await createTask(root, {
      title: "Plan in ticket",
      description: "Use workflow planning step.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });

    await processNextApprovedTask(root, { runner, wait: true });
    const afterFirst = await getTask(root, task.id);
    expect(afterFirst?.messages.some((m) => m.author === "agent")).toBe(true);
    expect(afterFirst && (await taskLegacyStatus(root, afterFirst))).toBe("awaiting_operator");
    expect(afterFirst?.workflowRun?.currentStepId).toBe("plan");

    const app = createServer({ root, runner, testMode: true });
    await request(app)
      .post(`/api/tasks/${task.id}/messages`)
      .send({ author: "operator", body: "Keep it KISS." })
      .expect(201);

    const deadline = Date.now() + 3000;
    let afterSecond = await getTask(root, task.id);
    while (afterSecond?.workflowRun?.currentStepId !== "plan_gate" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      afterSecond = await getTask(root, task.id);
    }
    expect(afterSecond?.workflowRun?.currentStepId).toBe("plan_gate");
    expect(afterSecond && (await taskLegacyStatus(root, afterSecond))).toBe("queued");
    expect(afterSecond?.messages?.some((m) => m.body.includes("Ship workflow refactor"))).toBe(true);
    expect(afterSecond?.description).not.toContain("## Plan");
  });
});