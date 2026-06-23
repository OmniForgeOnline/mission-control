import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import {
  canRevertToStep,
  downstreamStepIds,
  downstreamStepKinds,
  rewindWorkflowRunForRevert
} from "../src/core/workflows/revert.ts";
import { createWorkflowRun } from "../src/core/workflows/run.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import { revertTaskToWorkflowStep } from "../src/core/tasks/workflow-revert.ts";
import { saveUploadedAttachment } from "../src/core/attachments/store.ts";
import { runTaskTurn } from "../src/daemon/processor.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";
import type { HarnessTask } from "../src/core/types.ts";

function stubTask(run: ReturnType<typeof createWorkflowRun>): HarnessTask {
  const timestamp = new Date().toISOString();
  return {
    id: "t1",
    title: "T",
    description: "D",
    agent: "claude",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    workflowRun: run
  };
}

describe("workflow revert math", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-wf-revert-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists every step after the target as downstream", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    expect(downstreamStepIds(workflow, "implement")).toEqual([
      "create_merge_request",
      "resolve_conflicts",
      "review",
      "handoff"
    ]);
  });

  it("treats the initial step as having the whole workflow downstream", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    expect(downstreamStepIds(workflow, "plan")).toEqual([
      "plan_gate",
      "implement",
      "create_merge_request",
      "resolve_conflicts",
      "review",
      "handoff"
    ]);
  });

  it("returns only the tail when reverting from a late step", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    expect(downstreamStepIds(workflow, "review")).toEqual(["handoff"]);
  });

  it("collects the kinds of downstream steps so callers can scope artifact cleanup", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const kinds = downstreamStepKinds(workflow, "implement");
    expect(kinds.has("create_merge_request")).toBe(true);
    expect(kinds.has("resolve_conflicts")).toBe(true);
    expect(kinds.has("review")).toBe(true);
    expect(kinds.has("terminal")).toBe(true);
  });

  it("rewinds the frontier to the target while keeping ancestor progress", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "review";
    run.completedSteps = [
      "plan",
      "plan_gate",
      "implement",
      "create_merge_request"
    ];
    run.stepApprovals = {
      plan_gate: { stepId: "plan_gate", status: "approved" },
      implement: { stepId: "implement", status: "approved" }
    };

    const rewound = rewindWorkflowRunForRevert(workflow, run, "implement");

    expect(rewound.currentStepId).toBe("implement");
    expect(rewound.completedSteps).toEqual(["plan", "plan_gate"]);
    // The target's own approval is retained so the step can run immediately;
    // approvals for strictly downstream steps are dropped.
    expect(rewound.stepApprovals["plan_gate"]?.status).toBe("approved");
    expect(rewound.stepApprovals["implement"]?.status).toBe("approved");
    expect(rewound.activeStepIds).toBeUndefined();
  });

  it("discards per-step run outputs produced at or after the target", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "review";
    run.completedSteps = ["plan", "plan_gate", "implement", "create_merge_request"];
    run.stepRuns = {
      plan: ["run-plan-1"],
      plan_gate: ["run-gate-1"],
      implement: ["run-impl-1", "run-impl-2"],
      create_merge_request: ["run-mr-1"]
    };

    const rewound = rewindWorkflowRunForRevert(workflow, run, "implement");

    // Upstream outputs survive; target + downstream outputs are dropped so they
    // regenerate as execution proceeds forward from the target step.
    expect(rewound.stepRuns?.["plan"]).toEqual(["run-plan-1"]);
    expect(rewound.stepRuns?.["plan_gate"]).toEqual(["run-gate-1"]);
    expect(rewound.stepRuns?.["implement"]).toBeUndefined();
    expect(rewound.stepRuns?.["create_merge_request"]).toBeUndefined();
  });

  it("rewinds to the initial step by dropping all completed progress", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "review";
    run.completedSteps = ["plan", "plan_gate", "implement"];
    run.stepApprovals = {
      plan_gate: { stepId: "plan_gate", status: "approved" },
      implement: { stepId: "implement", status: "approved" }
    };

    const rewound = rewindWorkflowRunForRevert(workflow, run, "plan");

    expect(rewound.currentStepId).toBe("plan");
    expect(rewound.completedSteps).toEqual([]);
    expect(rewound.stepApprovals).toEqual({});
  });

  it("clears the parallel frontier when rewinding", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    const run = createWorkflowRun(workflow);
    run.currentStepId = "implement";
    // A hypothetical parallel frontier (code-feature itself is linear now); the
    // rewind must drop it regardless of how it was set.
    run.activeStepIds = ["build_a", "build_b"];
    run.completedSteps = ["plan", "plan_gate"];

    const rewound = rewindWorkflowRunForRevert(workflow, run, "plan_gate");
    expect(rewound.activeStepIds).toBeUndefined();
    expect(rewound.currentStepId).toBe("plan_gate");
  });

  describe("canRevertToStep", () => {
    it("allows reverting to any earlier or current non-terminal step", async () => {
      const workflow = await loadWorkflow(root, "code-feature");
      const run = createWorkflowRun(workflow);
      run.currentStepId = "review";
      const task = stubTask(run);

      expect(canRevertToStep(workflow, task, "plan")).toBe(true);
      expect(canRevertToStep(workflow, task, "implement")).toBe(true);
      expect(canRevertToStep(workflow, task, "review")).toBe(true);
    });

    it("rejects the terminal step as a revert target", async () => {
      const workflow = await loadWorkflow(root, "code-feature");
      const run = createWorkflowRun(workflow);
      run.currentStepId = "review";
      const task = stubTask(run);

      expect(canRevertToStep(workflow, task, "handoff")).toBe(false);
    });

    it("rejects an unknown step", async () => {
      const workflow = await loadWorkflow(root, "code-feature");
      const run = createWorkflowRun(workflow);
      run.currentStepId = "review";
      const task = stubTask(run);

      expect(canRevertToStep(workflow, task, "nope")).toBe(false);
    });

    it("rejects reverting forward to a later step", async () => {
      const workflow = await loadWorkflow(root, "code-feature");
      const run = createWorkflowRun(workflow);
      run.currentStepId = "plan";
      const task = stubTask(run);

      expect(canRevertToStep(workflow, task, "implement")).toBe(false);
    });

    it("allows reverting a completed (terminal) task back to an earlier step", async () => {
      const workflow = await loadWorkflow(root, "code-feature");
      const run = createWorkflowRun(workflow);
      run.currentStepId = "handoff";
      run.completedSteps = [
        "plan",
        "plan_gate",
        "implement",
        "lint",
        "unit",
        "typecheck",
        "create_merge_request",
        "review",
        "handoff"
      ];
      const task = stubTask(run);

      expect(canRevertToStep(workflow, task, "implement")).toBe(true);
      expect(canRevertToStep(workflow, task, "plan")).toBe(true);
    });

    it("rejects when the task has no workflow run", async () => {
      const workflow = await loadWorkflow(root, "code-feature");
      const task = stubTask(createWorkflowRun(workflow));
      const { workflowRun: _run, ...rest } = task;
      expect(canRevertToStep(workflow, rest as HarnessTask, "plan")).toBe(false);
    });
  });
});

/** Captures the prompt handed to the agent so tests can assert input wiring. */
class PromptCapturingRunner implements AgentRunner {
  agent = "claude";
  prompts: string[] = [];

  abort(): void {
    /* synchronous test runner */
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.prompts.push(request.prompt);
    return {
      reply: "Still working on the current step.",
      sessionId: request.sessionId ?? "new-session",
      exitCode: 0,
      command: "capturing-runner",
      rawLog: ""
    };
  }
}

const APPROVED_AT = "2026-06-06T12:00:00.000Z";

/** Seed a code-feature task that has run all the way to review with full artifacts. */
async function seedTaskAtReview(root: string): Promise<string> {
  const task = await createTask(root, {
    title: "Revert feature",
    description: "Build the thing.",
    workflowId: "code-feature",
    source: "manual",
    links: []
  });
  await updateTask(root, task.id, (current) => ({
    ...current,
    approvedAt: APPROVED_AT,
    startedAt: APPROVED_AT,
    turnCount: 4,
    repoPath: "/repos/example",
    branch: "harness/example",
    workspacePath: "/repos/example-work",
    pushedAt: "2026-06-06T12:30:00.000Z",
    commitCount: 3,
    mergeRequest: { provider: "github", url: "https://example/pr/1", number: 1 },
    reviewState: "changes_requested",
    reviewRounds: 2,
    checkRound: 1,
    lastCheckFailure: "lint failed",
    remediationStreak: 1,
    lastRemediationFingerprint: "abc",
    blockedReason: "Reviewer requested changes",
    agentSessionId: "sess-impl",
    agentSessionAgent: "claude",
    agentSessionModelPool: "claude-default",
    agentSessionConversation: false,
    resumeAttempts: 2,
    resumeAttemptsStepId: "implement",
    workflowRun: {
      workflowId: "code-feature",
      currentStepId: "review",
      completedSteps: ["plan", "plan_gate", "implement", "create_merge_request"],
      stepApprovals: {
        plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: APPROVED_AT },
        implement: { stepId: "implement", status: "approved", approvedAt: APPROVED_AT }
      },
      stepRuns: {
        plan: ["run-plan"],
        implement: ["run-impl-1", "run-impl-2"],
        create_merge_request: ["run-mr"]
      }
    }
  }));
  return task.id;
}

describe("revertTaskToWorkflowStep", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-task-revert-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rewinds the run to the target step and drops downstream progress", async () => {
    const taskId = await seedTaskAtReview(root);
    await revertTaskToWorkflowStep(root, taskId, "implement", { message: "Use approach B." });

    const updated = await getTask(root, taskId);
    const run = updated!.workflowRun!;
    expect(run.currentStepId).toBe("implement");
    expect(run.completedSteps).toEqual(["plan", "plan_gate"]);
    expect(run.stepApprovals["plan_gate"]?.status).toBe("approved");
    // Target approval is retained so the step runs immediately on resume.
    expect(run.stepApprovals["implement"]?.status).toBe("approved");
    expect(run.stepRuns?.["plan"]).toEqual(["run-plan"]);
    expect(run.stepRuns?.["implement"]).toBeUndefined();
    expect(run.stepRuns?.["create_merge_request"]).toBeUndefined();
  });

  it("clears downstream artifacts so execution regenerates them", async () => {
    const taskId = await seedTaskAtReview(root);
    await revertTaskToWorkflowStep(root, taskId, "implement", { message: "Use approach B." });

    const updated = await getTask(root, taskId);
    expect(updated?.mergeRequest).toBeUndefined();
    expect(updated?.pushedAt).toBeUndefined();
    expect(updated?.commitCount).toBeUndefined();
    expect(updated?.reviewState).toBeUndefined();
    expect(updated?.reviewRounds).toBeUndefined();
    expect(updated?.resolution).toBeUndefined();
    expect(updated?.completedAt).toBeUndefined();
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.checkRound).toBeUndefined();
    expect(updated?.lastCheckFailure).toBeUndefined();
    expect(updated?.agentSessionId).toBeUndefined();
    expect(updated?.resumeAttempts).toBeUndefined();
  });

  it("preserves task identity and the worktree binding", async () => {
    const taskId = await seedTaskAtReview(root);
    await revertTaskToWorkflowStep(root, taskId, "implement", { message: "Use approach B." });

    const updated = await getTask(root, taskId);
    expect(updated?.approvedAt).toBe(APPROVED_AT);
    expect(updated?.turnCount).toBe(4);
    expect(updated?.repoPath).toBe("/repos/example");
    expect(updated?.branch).toBe("harness/example");
    expect(updated?.workspacePath).toBe("/repos/example-work");
  });

  it("keeps merge-request and push artifacts when reverting to review", async () => {
    const taskId = await seedTaskAtReview(root);
    await revertTaskToWorkflowStep(root, taskId, "review", { message: "Re-examine the diff." });

    const updated = await getTask(root, taskId);
    expect(updated?.workflowRun?.currentStepId).toBe("review");
    // Review re-runs against the existing push/MR; only terminal completion clears.
    expect(updated?.mergeRequest).toBeDefined();
    expect(updated?.pushedAt).toBeDefined();
    expect(updated?.resolution).toBeUndefined();
    expect(updated?.completedAt).toBeUndefined();
  });

  it("records the operator message scoped to the target step", async () => {
    const taskId = await seedTaskAtReview(root);
    await revertTaskToWorkflowStep(root, taskId, "implement", { message: "Use approach B." });

    const updated = await getTask(root, taskId);
    const revertMessage = (updated?.messages ?? []).at(-1);
    expect(revertMessage?.author).toBe("operator");
    expect(revertMessage?.stepId).toBe("implement");
    expect(revertMessage?.body).toBe("Use approach B.");
  });

  it("persists attachments supplied with the operator revert message", async () => {
    const taskId = await seedTaskAtReview(root);
    const attachment = await saveUploadedAttachment(root, {
      filename: "approach-b.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4 approach b"),
      source: "workflow"
    });

    await revertTaskToWorkflowStep(root, taskId, "implement", {
      message: "Use approach B.",
      attachmentIds: [attachment.id]
    });

    const updated = await getTask(root, taskId);
    const revertMessage = (updated?.messages ?? []).at(-1);
    expect(revertMessage?.author).toBe("operator");
    expect(revertMessage?.stepId).toBe("implement");
    expect(revertMessage?.attachments).toHaveLength(1);
    expect(revertMessage?.attachments?.[0]).toMatchObject({
      id: attachment.id,
      filename: "approach-b.pdf"
    });
  });

  it("discards step-scoped outputs produced by steps after the target", async () => {
    const taskId = await seedTaskAtReview(root);
    await updateTask(root, taskId, (current) => ({
      ...current,
      messages: [
        { id: "m-plan", author: "agent", body: "Plan ready.", createdAt: APPROVED_AT, stepId: "plan" },
        { id: "m-mr", author: "system", body: "MR created.", createdAt: APPROVED_AT, stepId: "create_merge_request" },
        { id: "m-review", author: "system", body: "Reviewer round.", createdAt: APPROVED_AT, stepId: "review" },
        { id: "m-global", author: "operator", body: "Global note.", createdAt: APPROVED_AT }
      ]
    }));

    await revertTaskToWorkflowStep(root, taskId, "implement", { message: "Use approach B." });

    const updated = await getTask(root, taskId);
    const ids = (updated?.messages ?? []).map((m) => m.id);
    // Ancestor + unscoped messages survive; downstream step outputs are dropped.
    expect(ids).toContain("m-plan");
    expect(ids).toContain("m-global");
    expect(ids).not.toContain("m-mr");
    expect(ids).not.toContain("m-review");
    // The injected operator directive lands last, scoped to the target step.
    const injected = (updated?.messages ?? []).at(-1);
    expect(injected?.author).toBe("operator");
    expect(injected?.stepId).toBe("implement");
  });

  it("rejects a terminal or forward target step", async () => {
    const taskId = await seedTaskAtReview(root);
    await expect(
      revertTaskToWorkflowStep(root, taskId, "handoff", { message: "x" })
    ).rejects.toThrow(/Cannot revert/);
    await expect(
      revertTaskToWorkflowStep(root, taskId, "nope", { message: "x" })
    ).rejects.toThrow(/Cannot revert/);
  });

  it("resumes execution forward with the operator message as the step input", async () => {
    const taskId = await seedTaskAtReview(root);
    await revertTaskToWorkflowStep(root, taskId, "plan", { message: "Pivot to option two." });

    const runner = new PromptCapturingRunner();
    const turn = await runTaskTurn(root, taskId, { runner, wait: true });

    expect(turn?.execution).toBe("idle");
    expect(runner.prompts.length).toBe(1);
    expect(runner.prompts[0]).toContain("Pivot to option two.");
    const updated = await getTask(root, taskId);
    expect(updated?.workflowRun?.currentStepId).toBe("plan");
  });
});
