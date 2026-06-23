import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  branchNameFor,
  prepareStepWorkspace,
  prepareWorkspace,
  worktreePathFor
} from "../src/core/worktrees/worktrees.ts";
import { stepModifiesRepo, stepUsesRepoWorkspace } from "../src/core/workflows/index.ts";
import type { HarnessTask } from "../src/core/types.ts";
import type { WorkflowStep } from "../src/core/workflows/index.ts";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Harness Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}

function makeTask(overrides: Partial<HarnessTask> & Pick<HarnessTask, "id">): HarnessTask {
  const now = new Date().toISOString();
  return {
    title: "Test task",
    description: "Test",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("workflow repo step detection", () => {
  it("infers repo changes from pr-driven-execution skill", () => {
    const step: WorkflowStep = {
      id: "implement",
      kind: "agent_turn",
      agent: "author",
      skill: "pr-driven-execution",
      approval: "required",
      next: "checks"
    };
    expect(stepModifiesRepo(step)).toBe(true);
    expect(stepUsesRepoWorkspace(step, {})).toBe(true);
  });

  it("keeps conversation steps off repo worktrees", () => {
    const step: WorkflowStep = {
      id: "scope",
      kind: "conversation",
      agent: "author",
      skill: "product-discovery",
      approval: "none",
      next: "plan"
    };
    expect(stepModifiesRepo(step)).toBe(false);
    expect(stepUsesRepoWorkspace(step, { repoPath: "/repo", workspacePath: "/wt" })).toBe(false);
  });

  it("reuses repo workspace for resolve_conflicts and review after implementation", () => {
    const resolveConflicts: WorkflowStep = {
      id: "resolve_conflicts",
      kind: "resolve_conflicts",
      agent: "none",
      approval: "none",
      next: "review"
    };
    const review: WorkflowStep = {
      id: "review",
      kind: "review",
      agent: "reviewer",
      approval: "none",
      branch: { approved: "handoff" }
    };
    const task = { repoPath: "/repo", workspacePath: "/wt" };
    expect(stepUsesRepoWorkspace(resolveConflicts, task)).toBe(true);
    expect(stepUsesRepoWorkspace(review, task)).toBe(true);
  });
});

describe("prepareStepWorkspace", () => {
  let harnessRoot: string;
  let destinationRepo: string;

  beforeEach(async () => {
    harnessRoot = await mkdtemp(path.join(tmpdir(), "harness-wt-root-"));
    destinationRepo = await mkdtemp(path.join(tmpdir(), "harness-wt-dest-"));
    await initGitRepo(destinationRepo);
  });

  afterEach(async () => {
    await rm(harnessRoot, { recursive: true, force: true });
    await rm(destinationRepo, { recursive: true, force: true });
  });

  it("names branches from the task title with the short id for uniqueness", () => {
    const task = makeTask({
      id: "9b4de099-a5ff-4444-8888-999999999999",
      title: "Fix worktree branch naming!"
    });

    expect(branchNameFor(task)).toBe("harness/fix-worktree-branch-naming-9b4de099a5ff");
  });

  it("uses scratch for conversation steps even when the target is a git repo", async () => {
    const task = makeTask({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const step: WorkflowStep = {
      id: "scope_discovery",
      kind: "conversation",
      agent: "author",
      approval: "none",
      next: "plan"
    };

    const workspace = await prepareStepWorkspace(task, step, { harnessRoot });

    expect(workspace.isRepo).toBe(false);
    expect(workspace.cwd).toContain(path.join("data", "state", "scratch"));
    expect(workspace.created).toBe(false);
  });

  it("creates an isolated worktree and branch for repo-changing steps", async () => {
    const task = makeTask({
      id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const step: WorkflowStep = {
      id: "implement",
      kind: "agent_turn",
      agent: "author",
      skill: "pr-driven-execution",
      approval: "required",
      next: "checks"
    };

    const workspace = await prepareStepWorkspace(task, step, { harnessRoot });

    expect(workspace.isRepo).toBe(true);
    expect(workspace.created).toBe(true);
    expect(workspace.branch).toBe(branchNameFor(task));
    expect(workspace.cwd).toBe(worktreePathFor(harnessRoot, task));
    await expect(readFile(path.join(workspace.cwd, "README.md"), "utf8")).resolves.toContain("hello");
  });

  it("replaces stale unregistered worktree directories before creating the task worktree", async () => {
    const task = makeTask({
      id: "abababab-cdcd-efef-1212-343434343434",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const stalePath = worktreePathFor(harnessRoot, task);
    await mkdir(stalePath, { recursive: true });
    await writeFile(path.join(stalePath, "stale.txt"), "partial previous checkout\n", "utf8");

    const workspace = await prepareWorkspace(task, { harnessRoot });

    expect(workspace.cwd).toBe(stalePath);
    expect(workspace.isRepo).toBe(true);
    expect(workspace.created).toBe(true);
    await expect(readFile(path.join(workspace.cwd, "README.md"), "utf8")).resolves.toContain("hello");
    await expect(access(path.join(workspace.cwd, "stale.txt"))).rejects.toThrow();
  });

  it("deduplicates concurrent preparation for the same task worktree", async () => {
    const task = makeTask({
      id: "acacacac-bdbd-efef-1313-353535353535",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const [first, second] = await Promise.all([
      prepareWorkspace(task, { harnessRoot }),
      prepareWorkspace(task, { harnessRoot })
    ]);

    expect(first.cwd).toBe(worktreePathFor(harnessRoot, task));
    expect(second.cwd).toBe(first.cwd);
    expect(first.isRepo).toBe(true);
    expect(second.isRepo).toBe(true);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    await expect(readFile(path.join(first.cwd, "README.md"), "utf8")).resolves.toContain("hello");
  });

  it("branches new worktrees from origin/main when the local base is stale", async () => {
    const bareRemote = path.join(harnessRoot, "remote.git");
    await execFileAsync("git", ["init", "--bare", bareRemote]);
    await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

    await writeFile(path.join(destinationRepo, "on-main.txt"), "main tip\n", "utf8");
    await execFileAsync("git", ["add", "on-main.txt"], { cwd: destinationRepo });
    await execFileAsync("git", ["commit", "-m", "advance main"], { cwd: destinationRepo });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: destinationRepo });
    await execFileAsync("git", ["reset", "--hard", "HEAD~1"], { cwd: destinationRepo });

    const task = makeTask({
      id: "11111111-2222-3333-4444-555555555555",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const workspace = await prepareWorkspace(task, { harnessRoot });

    await expect(readFile(path.join(workspace.cwd, "on-main.txt"), "utf8")).resolves.toBe("main tip\n");
  });

  it("refreshes a reused worktree from origin/main on a fresh task turn", async () => {
    const bareRemote = path.join(harnessRoot, "remote.git");
    await execFileAsync("git", ["init", "--bare", bareRemote]);
    await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });

    const task = makeTask({
      id: "22222222-3333-4444-5555-666666666666",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const first = await prepareWorkspace(task, { harnessRoot });
    await writeFile(path.join(first.cwd, "stale.txt"), "orphan work\n", "utf8");
    await execFileAsync("git", ["add", "stale.txt"], { cwd: first.cwd });
    await execFileAsync("git", ["commit", "-m", "stale orphan"], { cwd: first.cwd });

    await writeFile(path.join(destinationRepo, "fresh-main.txt"), "latest main\n", "utf8");
    await execFileAsync("git", ["add", "fresh-main.txt"], { cwd: destinationRepo });
    await execFileAsync("git", ["commit", "-m", "advance main"], { cwd: destinationRepo });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: destinationRepo });

    const refreshed = await prepareWorkspace(task, { harnessRoot });

    expect(refreshed.cwd).toBe(first.cwd);
    await expect(readFile(path.join(refreshed.cwd, "fresh-main.txt"), "utf8")).resolves.toBe("latest main\n");
    await expect(access(path.join(refreshed.cwd, "stale.txt"))).rejects.toThrow();
  });

  it("keeps in-progress work when reusing a worktree after the first turn", async () => {
    const task = makeTask({
      id: "33333333-4444-5555-6666-777777777777",
      turnCount: 1,
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const step: WorkflowStep = {
      id: "resolve_conflicts",
      kind: "resolve_conflicts",
      agent: "none",
      approval: "none",
      next: "review"
    };

    const first = await prepareStepWorkspace(
      { ...task, turnCount: 0 },
      {
        id: "implement",
        kind: "agent_turn",
        agent: "author",
        skill: "pr-driven-execution",
        approval: "required",
        next: "resolve_conflicts"
      },
      { harnessRoot }
    );
    await writeFile(path.join(first.cwd, "feature.txt"), "in progress\n", "utf8");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: first.cwd });
    await execFileAsync("git", ["commit", "-m", "task work"], { cwd: first.cwd });

    const checksWorkspace = await prepareStepWorkspace(task, step, { harnessRoot });

    expect(checksWorkspace.cwd).toBe(first.cwd);
    await expect(readFile(path.join(checksWorkspace.cwd, "feature.txt"), "utf8")).resolves.toBe("in progress\n");
  });

  it("restores the task branch when reusing a worktree for review", async () => {
    const task = makeTask({
      id: "44444444-5555-6666-7777-888888888888",
      turnCount: 2,
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const implementStep: WorkflowStep = {
      id: "implement",
      kind: "agent_turn",
      agent: "author",
      skill: "pr-driven-execution",
      approval: "required",
      next: "checks"
    };
    const reviewStep: WorkflowStep = {
      id: "review",
      kind: "review",
      agent: "reviewer",
      approval: "none",
      branch: { approved: "handoff" }
    };

    const first = await prepareStepWorkspace({ ...task, turnCount: 0 }, implementStep, { harnessRoot });
    await writeFile(path.join(first.cwd, "review-me.txt"), "review branch\n", "utf8");
    await execFileAsync("git", ["add", "review-me.txt"], { cwd: first.cwd });
    await execFileAsync("git", ["commit", "-m", "task work"], { cwd: first.cwd });
    await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: first.cwd });

    const reviewWorkspace = await prepareStepWorkspace(task, reviewStep, { harnessRoot });

    expect(reviewWorkspace.cwd).toBe(first.cwd);
    const currentBranch = await execFileAsync("git", ["branch", "--show-current"], { cwd: reviewWorkspace.cwd });
    expect(currentBranch.stdout.trim()).toBe(branchNameFor(task));
    await expect(readFile(path.join(reviewWorkspace.cwd, "review-me.txt"), "utf8")).resolves.toBe("review branch\n");
  });

  it("does not link the destination repo's node_modules into a freshly created worktree", async () => {
    await mkdir(path.join(destinationRepo, "node_modules", "left-pad"), { recursive: true });
    await writeFile(
      path.join(destinationRepo, "node_modules", "left-pad", "index.js"),
      "module.exports = 1;\n",
      "utf8"
    );

    const task = makeTask({
      id: "eeeeeeee-ffff-0000-1111-222222222222",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const workspace = await prepareWorkspace(task, { harnessRoot });

    await expect(access(path.join(workspace.cwd, "node_modules"))).rejects.toThrow();
  });

  it("does not fail or create a link when the destination repo has no node_modules", async () => {
    const task = makeTask({
      id: "ffffffff-0000-1111-2222-333333333333",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const workspace = await prepareWorkspace(task, { harnessRoot });

    expect(workspace.isRepo).toBe(true);
    await expect(access(path.join(workspace.cwd, "node_modules"))).rejects.toThrow();
  });

  it("keeps reused worktrees isolated from destination repo dependencies", async () => {
    const bareRemote = path.join(harnessRoot, "remote.git");
    await execFileAsync("git", ["init", "--bare", bareRemote]);
    await execFileAsync("git", ["remote", "add", "origin", bareRemote], { cwd: destinationRepo });
    await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: destinationRepo });
    await mkdir(path.join(destinationRepo, "node_modules"), { recursive: true });
    await writeFile(path.join(destinationRepo, "node_modules", "marker.txt"), "dep\n", "utf8");

    const task = makeTask({
      id: "12121212-3434-5656-7878-909090909090",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });

    const first = await prepareWorkspace(task, { harnessRoot });
    await expect(access(path.join(first.cwd, "node_modules"))).rejects.toThrow();

    const reused = await prepareWorkspace(task, { harnessRoot });
    expect(reused.cwd).toBe(first.cwd);
    await expect(access(path.join(reused.cwd, "node_modules"))).rejects.toThrow();
  });

  it("gives parallel tasks distinct worktrees on the same destination repo", async () => {
    const taskA = makeTask({
      id: "cccccccc-dddd-eeee-ffff-000000000001",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const taskB = makeTask({
      id: "dddddddd-eeee-ffff-0000-111111111111",
      targets: [{ raw: `@${destinationRepo}`, path: destinationRepo, kind: "directory" }]
    });
    const step: WorkflowStep = {
      id: "implement",
      kind: "agent_turn",
      agent: "author",
      skill: "pr-driven-execution",
      approval: "required",
      next: "checks"
    };

    const workspaceA = await prepareStepWorkspace(taskA, step, { harnessRoot });
    const workspaceB = await prepareStepWorkspace(taskB, step, { harnessRoot });

    expect(workspaceA.cwd).not.toBe(workspaceB.cwd);
    expect(workspaceA.branch).not.toBe(workspaceB.branch);
  });
});
