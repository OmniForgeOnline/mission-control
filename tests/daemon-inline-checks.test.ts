import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runTaskTurn } from "../src/daemon/processor.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";

// The inline check loop is the single source of truth for mechanical checks after
// an implementation turn. It must run for every implementation turn, not only
// repo workspaces, so a non-repo project can never complete without the harness
// running its checks (or loudly reporting that none were detected).
describe("implementation turn inline checks visibility", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-inline-checks-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("posts a check outcome for a non-repo workspace, not a silent completion", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "harness-nonrepo-checks-"));
    try {
      const task = await createTask(root, {
        title: "Non-repo checks visibility",
        description: "Inline checks must run even without a repo.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${workDir}`, path: workDir, kind: "directory" }]
      });

      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn() {
          return {
            reply: "Done. All changes are complete; no further action needed.",
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
      // Non-repo gating: run the checks once and post the outcome. With no
      // detected checks there is nothing to gate, so this completes after the
      // loud no-checks message. (A workspace with detected but failing checks is
      // covered below: that case blocks.)
      expect(updated?.messages?.some((m) => m.body.includes("No mechanical checks detected"))).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("blocks a non-repo workspace when detected checks fail, instead of completing", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "harness-nonrepo-checks-fail-"));
    try {
      // Detected commands are part of the implementation prompt's contract: "the
      // harness re-runs these exact commands after your turn and blocks on
      // failure". A non-repo workspace that detects (but fails) those checks must
      // honor that contract and block, not post the outcome and complete.
      await mkdir(path.join(workDir, ".harness"), { recursive: true });
      await writeFile(
        path.join(workDir, ".harness", "checks.yml"),
        "checks:\n  - name: fail\n    command: exit 1\n",
        "utf8"
      );

      const task = await createTask(root, {
        title: "Non-repo failing checks gate",
        description: "Failing detected checks must block a non-repo workspace.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${workDir}`, path: workDir, kind: "directory" }]
      });

      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn() {
          return {
            reply: "Done. All changes are complete; no further action needed.",
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
      // Contract: the failure outcome is posted AND the checks gate holds the
      // workflow at the implementation step (it must not advance to a later step
      // such as the merge-request step, where a non-repo workspace would block
      // for an unrelated reason).
      expect(updated?.messages?.some((m) => m.body.includes("Mechanical checks failed"))).toBe(true);
      expect(updated?.workflowRun?.currentStepId).toBe("implement");
      expect(updated?.blockedReason).toContain("Mechanical checks");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("skips the inline check loop for a non-implementation agent turn", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "harness-nonimpl-checks-"));
    try {
      // data-analysis "collect" gathers data (skill: data-analysis): it is an
      // agent_turn, but not a repo-modifying author step, so it does not own the
      // work the checks validate. The loop must run only on the
      // implementation/authoring step, never on analysis/research/content turns,
      // or a project whose checks currently fail could hold a turn that has
      // nothing to do with them.
      const task = await createTask(root, {
        title: "Non-implementation turn skips checks",
        description: "A data-gathering turn must not be gated by project checks.",
        workflowId: "data-analysis",
        source: "manual",
        targets: [{ raw: `@${workDir}`, path: workDir, kind: "directory" }]
      });

      const runner = {
        agent: "grok" as const,
        abort() {},
        async runTurn() {
          return {
            reply: "Done. All changes are complete; no further action needed.",
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
          workflowId: "data-analysis",
          currentStepId: "collect",
          completedSteps: ["question"],
          stepApprovals: {}
        }
      }));

      await runTaskTurn(root, task.id, { runner, wait: true });

      const updated = await getTask(root, task.id);
      // No checks outcome is posted and the turn is not blocked: the loop is
      // gated to repo-modifying author steps, so a non-authoring turn advances
      // freely instead of being held by (or reporting on) the project checks.
      expect(updated?.messages?.some((m) => m.body.includes("No mechanical checks detected"))).toBe(false);
      expect(updated?.messages?.some((m) => m.body.includes("Mechanical checks failed"))).toBe(false);
      expect(updated?.blockedReason).toBeUndefined();
      expect(updated?.workflowRun?.currentStepId).toBe("analyze");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 15_000);
});
