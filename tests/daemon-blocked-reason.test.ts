import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { advanceAuthorTurnWorkflow } from "../src/daemon/agent-turn.ts";
import { runTaskTurn } from "../src/daemon/processor.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createRun } from "../src/core/tasks/runs.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";

const execFileAsync = promisify(execFile);

/**
 * Best-effort background writes (memory capture, run artifacts) can still be
 * flushing when the test tears down. macOS recursive rm is non-atomic, so a
 * file landing mid-removal throws ENOTEMPTY. Retry briefly until it drains.
 */
async function rmRoot(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "ENOTEMPTY" || code === "EBUSY") && attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

const STALE_BLOCKED_REASON =
  "Harness commit blocked: same pre-commit failure repeated 5 times:\n\nerror: remove .commit-blocker";

describe("daemon blockedReason cleanup", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-daemon-blocked-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rmRoot(root);
  });

  it("clears stale blockedReason after successful author commit and push", async () => {
    const destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-daemon-blocked-repo-"));
    const bareRemote = path.join(root, "remote-blocked-reason.git");

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
        title: "Clear stale blockedReason",
        description: "Recover from prior pre-commit block.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
      });

      let turn = 0;
      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn(request: { cwd: string }) {
          turn += 1;
          await mkdir(path.join(request.cwd, "tests"), { recursive: true });
          if (turn === 1) {
            await writeFile(path.join(request.cwd, "tests", "daemon-blocked-reason.test.ts"), "export {}\n", "utf8");
            await writeFile(path.join(request.cwd, ".commit-blocker"), "block\n", "utf8");
            return {
              reply: "**Pushed.** harness/test · add tests/daemon-blocked-reason.test.ts",
              exitCode: 0,
              command: "fake-grok",
              rawLog: ""
            };
          }
          await rm(path.join(request.cwd, ".commit-blocker"), { force: true });
          await execFileAsync("git", ["add", "."], { cwd: request.cwd });
          await execFileAsync("git", ["commit", "-m", "test: add daemon blocked reason coverage"], { cwd: request.cwd });
          await execFileAsync("git", ["push", "-u", "origin", "HEAD"], { cwd: request.cwd });
          return {
            reply: "**Pushed.** harness/test · add tests/daemon-blocked-reason.test.ts",
            exitCode: 0,
            command: "fake-grok",
            rawLog: ""
          };
        }
      };
      const approvedAt = new Date().toISOString();

      await updateTask(root, task.id, (current) => ({
        ...current,
        approvedAt,
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

      await runTaskTurn(root, task.id, { runner, wait: true });

      const updated = await getTask(root, task.id);
      expect(updated?.messages?.some((m) => m.body.includes("Author handoff did not satisfy the repo contract"))).toBe(true);
      expect(updated?.messages?.some((m) => m.body.includes("Harness committed and pushed"))).toBe(false);
      expect(updated?.blockedReason ?? "").not.toContain("Harness commit blocked");
      // The implementation turn's inline check loop posts a loud outcome message
      // even when no tooling is detected, so operators can see nothing was validated.
      expect(updated?.messages?.some((m) => m.body.includes("No mechanical checks detected"))).toBe(true);
    } finally {
      await rm(destinationRepo, { recursive: true, force: true });
    }
  }, 15_000);

  it("advanceAuthorTurnWorkflow clears stale blockedReason when advancing after push", async () => {
    const task = await createTask(root, {
      title: "Advance after stale block",
      description: "Workflow should drop blockedReason on success.",
      workflowId: "code-feature",
      source: "manual",
      links: [],
      targets: []
    });
    const run = await createRun(root, {
      taskId: task.id,
      taskTitle: task.title,
      agent: "grok",
      status: "completed",
      startedAt: new Date().toISOString(),
      artifacts: []
    });
    const approvedAt = new Date().toISOString();
    const completedAt = new Date().toISOString();

    await updateTask(root, task.id, (current) => ({
      ...current,
      blockedReason: STALE_BLOCKED_REASON,
      pushedAt: completedAt,
      mergeRequest: { provider: "github", url: "https://example.com/pr/1", number: 1 },
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

    const workflow = await loadWorkflow(root, "code-feature");
    const seeded = (await getTask(root, task.id))!;
    await advanceAuthorTurnWorkflow(root, {
      task: seeded,
      workflow,
      run,
      replyBody: "**Pushed.** harness/test · 1 commit(s).",
      workspace: { cwd: root, isRepo: false, branch: "harness/test", created: false },
      options: { wait: false },
      baseUpdates: { runId: run.id, turnCount: 3 },
      statusClear: ["currentActivity", "blockedReason"],
      runId: run.id,
      completedAt
    });

    const updated = await getTask(root, task.id);
    expect(updated?.blockedReason).toBeUndefined();
    expect(updated?.workflowRun?.currentStepId).not.toBe("implement");
    expect(updated?.workflowRun?.currentStepId).not.toBe("create_merge_request");
  });
});
