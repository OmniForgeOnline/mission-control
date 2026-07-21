import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processNextApprovedTask, runTaskTurn } from "../src/daemon/processor.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  advanceTaskWorkflowStep,
  createTask,
  getTask,
  updateTask
} from "../src/core/tasks/tasks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import { rmRoot } from "./helpers/rm-root.ts";
import {
  createWorkflowDaemonRoot,
  execFileAsync
} from "./helpers/workflow-daemon-helpers.ts";

describe("workflow-driven daemon", () => {
  let root: string;

  beforeEach(async () => {
    root = await createWorkflowDaemonRoot();
  });

  afterEach(async () => {
    await rmRoot(root);
  });

  it("agent selection still supports claude, codex, and grok", async () => {
    for (const agent of ["claude", "codex", "grok"] as const) {
      await createTask(root, {
        title: `Task for ${agent}`,
        description: "Agent support check.",
        workflowId: "code-feature",
        source: "manual",
        links: []
      });
      const summary = await processNextApprovedTask(root, {
        runner: new DeterministicAgentRunner(agent),
        wait: true
      });
      expect(summary?.runId).toBeTruthy();
      await rm(path.join(root, "data", "state", "tasks.json"), { force: true }).catch(() => {});
      await ensureHarnessRepository(root);
    }
  });

  it("branchless advance on review does not mark the task completed", async () => {
    const task = await createTask(root, {
      title: "Stuck on review",
      description: "Regression for premature completion.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = new Date().toISOString();

    await updateTask(root, task.id, (current) => ({
      ...current,
      status: "awaiting_review",
      approvedAt,
      turnCount: 3,
      pushedAt: approvedAt,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const first = await advanceTaskWorkflowStep(root, task.id);
    expect(first.resolution).toBeUndefined();
    expect(first.workflowRun?.currentStepId).toBe("review");
    expect(first.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(0);

    const second = await advanceTaskWorkflowStep(root, task.id);
    expect(second.resolution).toBeUndefined();
    expect(second.workflowRun?.currentStepId).toBe("review");
    expect(second.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(0);
  });

  it("approved branch advance completes terminal handoff in workflow metadata", async () => {
    const task = await createTask(root, {
      title: "Approved review",
      description: "Land on handoff with completed terminal metadata.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = new Date().toISOString();

    await updateTask(root, task.id, (current) => ({
      ...current,
      status: "awaiting_review",
      approvedAt,
      turnCount: 3,
      pushedAt: approvedAt,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const advanced = await advanceTaskWorkflowStep(root, task.id, "approved");

    expect(advanced.resolution).toBe("completed");
    expect(advanced.workflowRun?.currentStepId).toBe("handoff");
    expect(advanced.workflowRun?.completedSteps).toContain("review");
    expect(advanced.workflowRun?.completedSteps).toContain("handoff");
  });

  it("reviewer approval advances review to handoff and completes the task", async () => {
    const reviewerReply = `Review complete.

\`\`\`json
{"decision":"approve","summary":"Looks good.","comments":[]}
\`\`\``;
    const reviewerRunner = new DeterministicAgentRunner("codex");
    reviewerRunner.setReplies([reviewerReply]);

    const task = await createTask(root, {
      title: "Ready for review",
      description: "Ship after approval.",
      workflowId: "code-feature",
      source: "manual",
      links: []
    });
    const approvedAt = new Date().toISOString();

    await updateTask(root, task.id, (current) => ({
      ...current,
      status: "awaiting_review",
      approvedAt,
      turnCount: 3,
      pushedAt: approvedAt,
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: ["plan", "plan_gate", "implement", "checks", "create_merge_request"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
          implement: { stepId: "implement", status: "approved", approvedAt }
        }
      }
    }));

    const summary = await runTaskTurn(root, task.id, { reviewerRunner, wait: true });
    const updated = await getTask(root, task.id);

    expect(summary?.execution).toBe("idle");
    expect(updated?.resolution).toBe("completed");
    expect(updated?.workflowRun?.currentStepId).toBe("handoff");
    expect(updated?.workflowRun?.completedSteps).toContain("review");
    expect(updated?.workflowRun?.completedSteps.filter((stepId) => stepId === "review")).toHaveLength(1);
    expect(updated?.workflowRun?.completedSteps).toContain("handoff");
    expect(updated?.reviewState).toBe("approved");
  });

  it("advances implement after a pushed branch even without done/shipped keywords", async () => {
    const destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-wf-repo-"));
    const bareRemote = path.join(root, "remote.git");

    try {
      await execFileAsync("git", ["init"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: destinationRepo });
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: destinationRepo });
      await execFileAsync("git", ["branch", "-M", "main"], { cwd: destinationRepo });
      await execFileAsync("git", ["init", "--bare", bareRemote]);
      await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
      await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

      const task = await createTask(root, {
        title: "Quality gate: core",
        description: "Add tests.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
      });

      const branch = `harness/${task.id.replace(/-/g, "").slice(0, 12)}`;
      const handoffReply = `**Pushed.** ${branch} · 1 commit(s) · add tests/core.test.ts.

**Verified.** npm test (all pass).

**Open.** None.

**Watch.** None.

**Next.** Reviewer: confirm the push.`;

      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn(request: { cwd: string }) {
          await mkdir(path.join(request.cwd, "tests"), { recursive: true });
          await writeFile(path.join(request.cwd, "tests", "core.test.ts"), "export {}\n", "utf8");
          await execFileAsync("git", ["add", "."], { cwd: request.cwd });
          await execFileAsync("git", ["commit", "-m", "test: add core coverage"], { cwd: request.cwd });
          await execFileAsync("git", ["push", "-u", "origin", "HEAD"], { cwd: request.cwd });
          return {
            reply: handoffReply,
            exitCode: 0,
            command: "fake-grok",
            rawLog: ""
          };
        }
      };
      const approvedAt = new Date().toISOString();

      await updateTask(root, task.id, (current) => ({
        ...current,
        status: "approved",
        approvedAt,
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          completedSteps: ["plan", "plan_gate"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
            implement: { stepId: "implement", status: "approved", approvedAt }
          }
        },
        turnCount: 2
      }));

      await runTaskTurn(root, task.id, { runner, wait: true });

      const updated = await getTask(root, task.id);
      expect(updated?.workflowRun?.currentStepId).not.toBe("implement");
      expect(updated?.workflowRun?.completedSteps).toContain("implement");
    } finally {
      await rm(destinationRepo, { recursive: true, force: true });
    }
  });

  it("re-runs implement when the author claims completion without committing and pushing", async () => {
    const destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-wf-commit-fail-"));
    const bareRemote = path.join(root, "remote-commit-fail.git");

    try {
      await execFileAsync("git", ["init"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: destinationRepo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: destinationRepo });
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: destinationRepo });
      await execFileAsync("git", ["branch", "-M", "main"], { cwd: destinationRepo });
      await execFileAsync("git", ["init", "--bare", bareRemote]);
      await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
      await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

      const hookDir = path.join(destinationRepo, ".git", "hooks");
      await mkdir(hookDir, { recursive: true });
      const hookPath = path.join(hookDir, "pre-commit");
      await writeFile(
        hookPath,
        "#!/bin/sh\nif [ -f .commit-blocker ]; then\n  echo 'error: remove .commit-blocker'\n  exit 1\nfi\nexit 0\n",
        "utf8"
      );
      await chmod(hookPath, 0o755);

      const task = await createTask(root, {
        title: "Quality gate: runtime",
        description: "Add tests.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
      });

      let turn = 0;
      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn(request: { cwd: string; prompt: string }) {
          turn += 1;
          await mkdir(path.join(request.cwd, "tests"), { recursive: true });
          if (turn === 1) {
            await writeFile(path.join(request.cwd, "tests", "runtime.test.ts"), "export {}\n", "utf8");
            await writeFile(path.join(request.cwd, ".commit-blocker"), "block\n", "utf8");
            return {
              reply: "**Pushed.** harness/test · add tests/runtime.test.ts",
              exitCode: 0,
              command: "fake-grok",
              rawLog: ""
            };
          }
          await rm(path.join(request.cwd, ".commit-blocker"), { force: true });
          await execFileAsync("git", ["add", "."], { cwd: request.cwd });
          await execFileAsync("git", ["commit", "-m", "test: add runtime coverage"], { cwd: request.cwd });
          await execFileAsync("git", ["push", "-u", "origin", "HEAD"], { cwd: request.cwd });
          return {
            reply: "**Pushed.** harness/test · add tests/runtime.test.ts",
            exitCode: 0,
            command: "fake-grok",
            rawLog: ""
          };
        }
      };
      const approvedAt = new Date().toISOString();

      await updateTask(root, task.id, (current) => ({
        ...current,
        status: "approved",
        approvedAt,
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          completedSteps: ["plan", "plan_gate"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt },
            implement: { stepId: "implement", status: "approved", approvedAt }
          }
        },
        turnCount: 2
      }));

      await runTaskTurn(root, task.id, { runner, wait: true });

      const updated = await getTask(root, task.id);
      expect(updated?.messages?.some((m) => m.body.includes("Author handoff did not satisfy the repo contract"))).toBe(true);
      expect(updated?.messages?.some((m) => m.body.includes("Harness committed and pushed"))).toBe(false);
      expect(updated?.turnCount).toBeGreaterThanOrEqual(4);
      expect(updated?.workflowRun?.currentStepId).not.toBe("implement");
      expect(updated?.blockedReason ?? "").not.toContain("Harness commit blocked");
    } finally {
      await rm(destinationRepo, { recursive: true, force: true });
    }
  });
});
