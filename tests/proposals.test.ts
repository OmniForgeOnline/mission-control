import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProposal, listProposals } from "../src/core/proposals/proposals.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { taskLegacyStatus } from "./helpers/task-status.ts";
import { approveTask, cancelTask, createTask, listTasks } from "../src/core/tasks/tasks.ts";
import { DEFAULT_WORKFLOW_ID } from "../src/core/workflows/index.ts";
import { createServer } from "../src/server/app.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import request from "supertest";

describe("harness proposals", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-proposals-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("captures memory proposals locally without creating a task or worktree", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: root });
    await ensureHarnessRepository(root);
    execSync("git init app", { cwd: root });
    const { onboardProject, projectDir } = await import("../src/core/projects/registry.ts");
    const projectId = (await onboardProject(root, { repoPath: path.join(root, "app"), name: "app" })).id;
    const proposal = await createProposal(root, {
      kind: "memory",
      projectId,
      title: "Prefer Make targets",
      rationale: "This preference appeared in multiple repository instructions.",
      targetPath: "data/memory/pages/preferences/make-targets.md",
      content: "- Prefer Makefile targets over direct tool commands when a project provides them.\n"
    });

    expect(proposal).toMatchObject({
      kind: "memory",
      status: "approved",
      targetPath: "data/memory/pages/preferences/make-targets.md"
    });
    expect((await listTasks(root)).some((entry) => entry.title === "Prefer Make targets")).toBe(false);
    const pagePath = path.join(projectDir(root, projectId), "memory", "pages", "preferences", "make-targets.md");
    await expect(readFile(pagePath, "utf8")).resolves.toContain("Prefer Makefile targets");
    await expect(readFile(pagePath, "utf8")).resolves.toContain(
      "This preference appeared in multiple repository instructions."
    );
  });

  it("creates a normal task ticket indistinguishable from operator intake", async () => {
    await ensureHarnessRepository(root);
    const proposal = await createProposal(root, {
      kind: "rule",
      title: "Operating note",
      rationale: "Docs-only change.",
      targetPath: "kernel/operating-principles.md",
      content: "- Example rule.\n"
    });

    const task = (await listTasks(root)).find((entry) => entry.id === proposal.id)!;
    const manual = await createTask(root, {
      title: "Manual comparator",
      description: "Operator filed this.",
      source: "manual",
      links: [],
      targets: [{ raw: "kernel/x.md", path: "kernel/x.md", kind: "file" }]
    });

    expect(task.label).toBeUndefined();
    expect(task.proposalChange).toBeUndefined();
    expect(task.source).toBe("manual");
    expect(task.workflowRun?.workflowId).toBe(DEFAULT_WORKFLOW_ID);
    expect(manual.workflowRun?.workflowId).toBe(DEFAULT_WORKFLOW_ID);
    expect(task.description).toContain("## Proposal");
    expect(task.targets?.[0]?.path).toBe("kernel/operating-principles.md");
  });

  it("accepts an explicit workflow id like createTask", async () => {
    await ensureHarnessRepository(root);
    const proposal = await createProposal(root, {
      kind: "rule",
      title: "Kernel note",
      rationale: "Docs-only change.",
      targetPath: "kernel/operating-principles.md",
      content: "- Example rule.\n",
      workflowId: "docs-update"
    });

    const task = (await listTasks(root)).find((entry) => entry.id === proposal.id);
    expect(task?.workflowRun?.workflowId).toBe("docs-update");
  });

  it("does not write files until a workflow turn applies the change", async () => {
    await ensureHarnessRepository(root);
    const proposal = await createProposal(root, {
      kind: "rule",
      title: "Daemon lifecycle",
      rationale: "Restart after workflow deploys.",
      targetPath: "kernel/operating-principles.md",
      content: "- Restart the harness daemon after deploying workflow-engine changes.\n",
      workflowId: "docs-update"
    });

    await approveTask(root, proposal.id);
    const task = (await listTasks(root)).find((entry) => entry.id === proposal.id);

    expect(task && (await taskLegacyStatus(root, task))).toBe("approved");
    await expect(readFile(path.join(root, "kernel", "operating-principles.md"), "utf8")).resolves.not.toContain(
      "Restart the harness daemon"
    );
  });

  it("can reject a filed ticket without applying it", async () => {
    await ensureHarnessRepository(root);
    const proposal = await createProposal(root, {
      kind: "rule",
      title: "Too broad",
      rationale: "Not stable enough.",
      targetPath: "kernel/operating-principles.md",
      content: "- Always use one exact tool for every task.\n"
    });

    await cancelTask(root, proposal.id);
    const rejected = (await listProposals(root))[0]!;
    expect(rejected.status).toBe("rejected");
    expect((await listProposals(root))[0]?.status).toBe("rejected");
  });

  it("migrates legacy proposal sidecars into operator-equivalent tickets", async () => {
    await ensureHarnessRepository(root);
    const tasksPath = path.join(root, "data", "state", "tasks.json");
    const { writeJsonFile } = await import("../src/core/infra/fs.ts");
    await writeJsonFile(tasksPath, [
      {
        id: "legacy-proposal-1",
        title: "Kernel note",
        description: "Short rationale only.",
        agent: "grok",
        source: "agent",
        links: [],
        targets: [],
        messages: [],
        status: "queued",
        label: "proposal",
        proposalChange: {
          kind: "rule",
          targetPath: "kernel/operating-principles.md",
          content: "- Example rule.\n"
        },
        createdAt: "2026-06-06T00:00:00.000Z",
        updatedAt: "2026-06-06T00:00:00.000Z"
      }
    ]);

    const task = (await listTasks(root)).find((entry) => entry.id === "legacy-proposal-1")!;
    expect(task.source).toBe("manual");
    expect(task.label).toBeUndefined();
    expect(task.proposalChange).toBeUndefined();
    expect(task.description).toContain("## Proposal");
    expect(task.targets?.[0]?.path).toBe("kernel/operating-principles.md");
  });

  it("does not create a duplicate when the same target already has an active ticket", async () => {
    await ensureHarnessRepository(root);
    const first = await createProposal(root, {
      kind: "rule",
      title: "Post-push advancement",
      rationale: "Kernel policy needs cleanup.",
      targetPath: "kernel/workflow-policy.md",
      content: "- Advance after push.\n"
    });

    const second = await createProposal(root, {
      kind: "rule",
      title: "Different title, same target",
      rationale: "Another agent pass on the same file.",
      targetPath: "kernel/workflow-policy.md",
      content: "- Duplicate attempt.\n"
    });

    expect(second.id).toBe(first.id);
    expect((await listTasks(root)).filter((task) => task.description.includes("kernel/workflow-policy.md"))).toHaveLength(1);
  });

  it("allows a new ticket after the prior one on the same target completed", async () => {
    await ensureHarnessRepository(root);
    const first = await createProposal(root, {
      kind: "skill",
      title: "Skill update",
      rationale: "First pass.",
      targetPath: "skills/example/SKILL.md",
      content: "# Example\n"
    });

    await approveTask(root, first.id);
    const { updateTask } = await import("../src/core/tasks/tasks.ts");
    await updateTask(root, first.id, (task) => ({ ...task, status: "completed", completedAt: new Date().toISOString() }));

    const second = await createProposal(root, {
      kind: "skill",
      title: "Skill update follow-up",
      rationale: "Second pass after merge.",
      targetPath: "skills/example/SKILL.md",
      content: "# Example v2\n"
    });

    expect(second.id).not.toBe(first.id);
    expect((await listTasks(root))).toHaveLength(2);
  });

  it("runs through approve-and-turn like any other ticket", async () => {
    await ensureHarnessRepository(root);
    const app = createServer({ root, runner: new DeterministicAgentRunner("claude"), testMode: true });
    const proposal = await createProposal(root, {
      kind: "skill",
      title: "Review release notes",
      rationale: "Repeatable release workflow.",
      targetPath: "skills/release-notes/SKILL.md",
      content: "# Release Notes\n\nCheck the changelog before drafting.\n",
      workflowId: "docs-update"
    });

    await approveTask(root, proposal.id);
    await request(app).post(`/api/tasks/${proposal.id}/turn`).expect(200);

    const task = (await listTasks(root)).find((entry) => entry.id === proposal.id);
    expect(task?.turnCount).toBe(1);
    expect(task?.source).toBe("manual");
  });
});