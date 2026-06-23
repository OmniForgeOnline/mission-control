import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { executeResolveConflictsStep } from "../src/daemon/step-handlers/resolve-conflicts.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import type { PreparedWorkspace } from "../src/core/worktrees/worktrees.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Harness Test"]);
  await writeFile(path.join(dir, "a.txt"), "base\n", "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "init"]);
}

async function commitFile(dir: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(path.join(dir, file), contents, "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", message]);
}

async function hasMergeInProgress(dir: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

function workspaceFor(repoDir: string): PreparedWorkspace {
  return { cwd: repoDir, repoPath: repoDir, branch: "harness/test", isRepo: true, created: false };
}

describe("resolve_conflicts workflow wiring", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-rc-wiring-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("inserts resolve_conflicts between create_merge_request and review", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    expect(workflow.steps["create_merge_request"]?.next).toBe("resolve_conflicts");
    const step = workflow.steps["resolve_conflicts"];
    expect(step?.kind).toBe("resolve_conflicts");
    expect(step?.next).toBe("review");
    expect(step?.branch?.["conflicts"]).toBe("implement");
  });

  it("wires resolve_conflicts into every git workflow", async () => {
    const expected: Record<string, string> = {
      "code-feature": "implement",
      bugfix: "fix",
      "technical-debt": "implement",
      "infrastructure-change": "apply_change",
      "frontend-ui-change": "implement_ui"
    };
    for (const [id, authorStep] of Object.entries(expected)) {
      const workflow = await loadWorkflow(root, id);
      const step = workflow.steps["resolve_conflicts"];
      expect(step?.kind).toBe("resolve_conflicts");
      expect(step?.branch?.["conflicts"]).toBe(authorStep);
    }
  });
});

describe("executeResolveConflictsStep", () => {
  let root: string;
  let repoDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-rc-step-"));
    await ensureHarnessRepository(root);
    repoDir = await mkdtemp(path.join(tmpdir(), "harness-rc-repo-"));
    await initRepo(repoDir);
    await git(repoDir, ["checkout", "-b", "harness/test"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  async function makeTaskOnResolveStep(): Promise<string> {
    const task = await createTask(root, {
      title: "Resolve conflicts task",
      description: "Needs a mergeable branch.",
      workflowId: "code-feature",
      source: "manual",
      targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
    });
    await updateTask(root, task.id, (current) => ({
      ...current,
      workflowRun: { ...current.workflowRun!, currentStepId: "resolve_conflicts" },
      repoPath: repoDir,
      branch: "harness/test",
      workspacePath: repoDir,
      pushedAt: new Date().toISOString()
    }));
    return task.id;
  }

  it("advances to review when the branch is already mergeable", async () => {
    await commitFile(repoDir, "feature.txt", "feature\n", "feature work");
    const taskId = await makeTaskOnResolveStep();
    const workflow = await loadWorkflow(root, "code-feature");
    const task = (await getTask(root, taskId))!;

    const summary = await executeResolveConflictsStep(
      root,
      task,
      workspaceFor(repoDir),
      workflow,
      workflow.steps["resolve_conflicts"]!
    );

    const updated = await getTask(root, taskId);
    expect(summary.execution).not.toBe("blocked");
    expect(updated?.workflowRun?.currentStepId).toBe("review");
  });

  it("blocks and aborts the merge once the conflict cap is exceeded", async () => {
    await commitFile(repoDir, "a.txt", "feature change\n", "feature edits a.txt");
    await git(repoDir, ["checkout", "main"]);
    await commitFile(repoDir, "a.txt", "main change\n", "main edits a.txt");
    await git(repoDir, ["checkout", "harness/test"]);

    const taskId = await makeTaskOnResolveStep();
    await updateTask(root, taskId, (current) => ({ ...current, conflictRound: 49 }));
    const workflow = await loadWorkflow(root, "code-feature");
    const task = (await getTask(root, taskId))!;

    const summary = await executeResolveConflictsStep(
      root,
      task,
      workspaceFor(repoDir),
      workflow,
      workflow.steps["resolve_conflicts"]!
    );

    const updated = await getTask(root, taskId);
    expect(summary.execution).toBe("blocked");
    expect(updated?.blockedReason).toContain("Merge conflict resolution blocked");
    expect(await hasMergeInProgress(repoDir)).toBe(false);
  });
});
