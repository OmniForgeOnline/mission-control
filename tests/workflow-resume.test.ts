import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { resumeTask } from "../src/daemon/processor.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import { prepareStepWorkspace } from "../src/core/worktrees/worktrees.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import { getCurrentStep } from "../src/core/workflows/run.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";

const execFileAsync = promisify(execFile);

class CapturingRunner implements AgentRunner {
  agent = "grok";
  sessionIds: Array<string | undefined> = [];

  abort(): void {
    /* test runner is synchronous */
  }

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.sessionIds.push(request.sessionId);
    return {
      reply: "Still working on the current step.",
      sessionId: request.sessionId ?? "new-session",
      exitCode: 0,
      command: "capturing-runner",
      rawLog: ""
    };
  }
}

describe("workflow blocked step resume", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-workflow-resume-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("retries the blocked current step without resetting workflow progress", async () => {
    const task = await createTask(root, {
      title: "Resume blocked implement",
      description: "Retry only the current step.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = "2026-06-06T12:00:00.000Z";
    const staleCompletedAt = "2026-06-06T12:05:00.000Z";
    await updateTask(root, task.id, (current) => ({
      ...current,
      approvedAt,
      completedAt: staleCompletedAt,
      blockedReason: "API Error: 529 service temporarily overloaded",
      agentSessionId: "sess-implement-1",
      agentSessionAgent: "claude",
      agentSessionModelPool: "claude-default",
      agentSessionConversation: false,
      turnCount: 2,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "implement",
        completedSteps: ["plan", "plan_gate"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const runner = new CapturingRunner();
    const resumed = await resumeTask(root, task.id, { runner, wait: true });

    expect(resumed?.execution).toBe("idle");
    expect(runner.sessionIds).toEqual(["sess-implement-1"]);
    const updated = await getTask(root, task.id);
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.completedAt).toBeUndefined();
    expect(updated?.resumeAttempts).toBe(1);
    expect(updated?.turnCount).toBe(3);
    expect(updated?.agentSessionId).toBe("sess-implement-1");
    expect(updated?.workflowRun?.currentStepId).toBe("implement");
    expect(updated?.workflowRun?.completedSteps).toEqual(["plan", "plan_gate"]);
    expect(updated?.workflowRun?.stepApprovals["implement"]?.status).toBe("approved");
  });

  it("keeps the resume attempt cap for repeated resumes on the same step", async () => {
    const task = await createTask(root, {
      title: "Resume cap",
      description: "Do not retry forever.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    await updateTask(root, task.id, (current) => ({
      ...current,
      blockedReason: "API Error: 529 service temporarily overloaded",
      resumeAttempts: 3,
      resumeAttemptsStepId: "implement",
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "implement",
        completedSteps: ["plan", "plan_gate"],
        stepApprovals: {}
      }
    }));

    const resumed = await resumeTask(root, task.id, { runner: new CapturingRunner(), wait: true });

    expect(resumed).toBeNull();
    expect((await getTask(root, task.id))?.blockedReason).toBe("Exceeded maximum resume attempts (3)");
  });

  it("resets the resume budget when the task has advanced to a new step", async () => {
    const task = await createTask(root, {
      title: "Resume cap per step",
      description: "Earlier-step resumes must not exhaust a later step's budget.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = "2026-06-06T12:00:00.000Z";
    // The lifetime counter is maxed, but it was accrued on an earlier step.
    await updateTask(root, task.id, (current) => ({
      ...current,
      approvedAt,
      blockedReason: "API Error: 529 service temporarily overloaded",
      resumeAttempts: 3,
      resumeAttemptsStepId: "plan",
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "implement",
        completedSteps: ["plan", "plan_gate"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const resumed = await resumeTask(root, task.id, { runner: new CapturingRunner(), wait: true });

    expect(resumed?.execution).toBe("idle");
    const updated = await getTask(root, task.id);
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.resumeAttempts).toBe(1);
    expect(updated?.resumeAttemptsStepId).toBe("implement");
  });

  it("advances a blocked repo step when its branch is already pushed", async () => {
    const destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-workflow-resume-repo-"));
    const bareRemote = path.join(root, "remote.git");
    try {
      await execFileAsync("git", ["init"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: destinationRepo });
      await writeFile(path.join(destinationRepo, "README.md"), "base\n", "utf8");
      await execFileAsync("git", ["add", "README.md"], { cwd: destinationRepo });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: destinationRepo });
      await execFileAsync("git", ["branch", "-M", "main"], { cwd: destinationRepo });
      await execFileAsync("git", ["init", "--bare", bareRemote]);
      await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
      await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

      const task = await createTask(root, {
        title: "Already pushed frontend change",
        description: "Recover stale block after push.",
        workflowId: "frontend-ui-change",
        source: "manual",
        targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
      });
      const approvedAt = "2026-06-06T12:00:00.000Z";
      let preparedTask = await updateTask(root, task.id, (current) => ({
        ...current,
        approvedAt,
        workflowRun: {
          workflowId: "frontend-ui-change",
          currentStepId: "implement_ui",
          completedSteps: ["ux_scope", "implementation_plan"],
          stepApprovals: {
            implement_ui: { stepId: "implement_ui", status: "approved", approvedAt }
          }
        }
      }));
      const workflow = await loadWorkflow(root, "frontend-ui-change");
      const step = getCurrentStep(workflow, preparedTask.workflowRun!);
      const workspace = await prepareStepWorkspace(preparedTask, step, { harnessRoot: root });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace.cwd });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace.cwd });
      await writeFile(path.join(workspace.cwd, "feature.txt"), "done\n", "utf8");
      await execFileAsync("git", ["add", "feature.txt"], { cwd: workspace.cwd });
      await execFileAsync("git", ["commit", "-m", "feature"], { cwd: workspace.cwd });
      await execFileAsync("git", ["push", "-u", "origin", workspace.branch!], { cwd: workspace.cwd });
      preparedTask = await updateTask(root, task.id, (current) => ({
        ...current,
        workspacePath: workspace.cwd,
        ...(workspace.repoPath !== undefined ? { repoPath: workspace.repoPath } : {}),
        ...(workspace.branch !== undefined ? { branch: workspace.branch } : {}),
        blockedReason: "claude exited with code 1",
        completedAt: "2026-06-06T12:05:00.000Z",
        turnCount: 2,
        checkRound: 2,
        lastCheckFailure: "stale commit failure"
      }));

      const runner = new CapturingRunner();
      await resumeTask(root, preparedTask.id, { runner, wait: true });

      const updated = await getTask(root, preparedTask.id);
      expect(updated?.blockedReason).toBeUndefined();
      expect(updated?.completedAt).toBeUndefined();
      expect(updated?.pushedAt).toBeDefined();
      expect(updated?.commitCount).toBeGreaterThan(0);
      expect(updated?.checkRound).toBe(0);
      expect(updated?.lastCheckFailure).toBeUndefined();
      expect(updated?.workflowRun?.completedSteps).toContain("implement_ui");
      expect(updated?.workflowRun?.currentStepId).toBe("create_merge_request");
    } finally {
      await rm(destinationRepo, { recursive: true, force: true });
    }
  });
});
