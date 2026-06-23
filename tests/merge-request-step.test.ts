import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectWithToken } from "../src/connectors/connections.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import { runTaskTurn } from "../src/daemon/processor.ts";
import { loadWorkflow } from "../src/core/workflows/index.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";

describe("create_merge_request workflow step", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-mr-step-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("validates create_merge_request as a workflow step kind", async () => {
    const workflow = await loadWorkflow(root, "code-feature");
    expect(workflow.steps['create_merge_request']?.kind).toBe("create_merge_request");
    expect(workflow.steps['create_merge_request']?.next).toBe("resolve_conflicts");
  });

  it("blocks merge request creation for non-repo tasks", async () => {
    const task = await createTask(root, {
      title: "Scratch task",
      description: "No repo.",
      workflowId: "code-feature",
      source: "manual",
      targets: []
    });

    await updateTask(root, task.id, (current) => ({
      ...current,
      targets: [],
      workflowRun: {
        ...current.workflowRun!,
        currentStepId: "create_merge_request"
      },
    }));

    const summary = await runTaskTurn(root, task.id);
    const updated = await getTask(root, task.id);
    expect(summary?.execution).toBe("blocked");
    expect(updated?.blockedReason).toContain("Repository binding required");
    expect(updated?.workflowRun?.currentStepId).toBe("create_merge_request");
    expect(updated?.mergeRequest).toBeUndefined();
  });

  it("blocks when branch was not pushed", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-step-repo-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });

      const task = await createTask(root, {
        title: "Repo task",
        description: "Needs push first.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
      });

      await updateTask(root, task.id, (current) => ({
        ...current,
        workflowRun: {
          ...current.workflowRun!,
          currentStepId: "create_merge_request"
        },
        repoPath: repoDir,
        branch: "harness/test",
        workspacePath: repoDir,
      }));

      const summary = await runTaskTurn(root, task.id);
      const updated = await getTask(root, task.id);
      expect(summary?.execution).toBe("blocked");
      expect(updated?.blockedReason).toContain("pushed branch");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("creates merge request and advances to review when pushed", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-step-repo-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Harness change"], { cwd: repoDir });

      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/pulls?") && (!init || init.method === undefined)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.endsWith("/pulls") && init?.method === "POST") {
          return new Response(JSON.stringify({ number: 12, html_url: "https://github.com/o/r/pull/12" }), {
            status: 201
          });
        }
        if (url.endsWith("/pulls/12") && (!init || init.method === undefined)) {
          return new Response(JSON.stringify({ number: 12, draft: true, node_id: "PR_node_12" }), {
            status: 200
          });
        }
        if (url === "https://api.github.com/graphql" && init?.method === "POST") {
          return new Response(
            JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_node_12" } } } }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchImpl);

      const task = await createTask(root, {
        title: "Repo task",
        description: "## Goal\nShip MR stage.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
      });

      await updateTask(root, task.id, (current) => ({
        ...current,
        workflowRun: {
          ...current.workflowRun!,
          currentStepId: "create_merge_request"
        },
        repoPath: repoDir,
        branch: "harness/test",
        workspacePath: repoDir,
        pushedAt: new Date().toISOString(),
      }));

      const reviewerRunner = new DeterministicAgentRunner("codex");
      reviewerRunner.setReplies([
        '```json\n{"decision":"approve","summary":"Looks good.","comments":[]}\n```'
      ]);

      const summary = await runTaskTurn(root, task.id, {
        runner: new DeterministicAgentRunner("grok"),
        reviewerRunner,
        wait: true
      });
      const updated = await getTask(root, task.id);

      expect(summary?.execution).toBe("idle");
      // The MR is open (not merged): approval advances to handoff but must not
      // complete the task. It stays unresolved, awaiting merge.
      expect(updated?.resolution).toBeUndefined();
      expect(updated?.completedAt).toBeUndefined();
      expect(updated?.blockedReason).toBeUndefined();
      expect(updated?.mergeRequest).toEqual({
        provider: "github",
        url: "https://github.com/o/r/pull/12",
        number: 12
      });
      expect(updated?.workflowRun?.currentStepId).toBe("handoff");
      expect(updated?.messages?.some((m) => m.author === "system" && m.body.includes("[#12]"))).toBe(true);

      // Opened as draft at creation time...
      const createCall = fetchImpl.mock.calls.find(
        ([url, init]) =>
          url === "https://api.github.com/repos/octocat/hello-world/pulls" &&
          (init as RequestInit | undefined)?.method === "POST"
      );
      expect(JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body))).toMatchObject({
        draft: true
      });

      // ...and marked ready for review only once review approves and we reach handoff.
      const readyCall = fetchImpl.mock.calls.find(([url]) => url === "https://api.github.com/graphql");
      expect(readyCall).toBeTruthy();
      expect(String((readyCall?.[1] as RequestInit | undefined)?.body)).toContain(
        "markPullRequestReadyForReview"
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(repoDir, { recursive: true, force: true });
    }
  }, 15000);

  it("skips merge request creation when the task already has an MR", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-step-existing-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });

      const task = await createTask(root, {
        title: "Existing MR task",
        description: "Review loop should reuse the MR.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
      });

      await updateTask(root, task.id, (current) => ({
        ...current,
        workflowRun: {
          ...current.workflowRun!,
          currentStepId: "create_merge_request"
        },
        mergeRequest: {
          provider: "github",
          url: "https://github.com/o/r/pull/12",
          number: 12
        },
        repoPath: repoDir,
        branch: "harness/test",
        workspacePath: repoDir,
        pushedAt: new Date().toISOString()
      }));

      const reviewerRunner = new DeterministicAgentRunner("codex");
      reviewerRunner.setReplies([
        '```json\n{"decision":"approve","summary":"No remaining comments.","comments":[]}\n```'
      ]);

      const summary = await runTaskTurn(root, task.id, {
        runner: new DeterministicAgentRunner("grok"),
        reviewerRunner,
        wait: true
      });
      const updated = await getTask(root, task.id);

      expect(summary?.execution).toBe("idle");
      // Pre-existing open MR: approval must not complete the task either.
      expect(updated?.resolution).toBeUndefined();
      expect(updated?.completedAt).toBeUndefined();
      expect(updated?.mergeRequest?.number).toBe(12);
      expect(updated?.workflowRun?.currentStepId).toBe("handoff");
      expect(updated?.workflowRun?.completedSteps).toContain("create_merge_request");
      expect(updated?.messages?.some((m) => m.author === "system" && m.body.includes("[#12]"))).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("keeps the merge request draft when review requests changes", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-step-changes-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
      await exec("git", ["commit", "--allow-empty", "-m", "Initial"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });

      const fetchImpl = vi.fn(async (_url: string) => new Response("not found", { status: 404 }));
      vi.stubGlobal("fetch", fetchImpl);

      const reviewerReply =
        '```json\n{"decision":"changes_requested","summary":"Needs work.","comments":["Fix edge case."]}\n```';
      const reviewerRunner = new DeterministicAgentRunner("codex");
      reviewerRunner.setReplies([reviewerReply]);

      const task = await createTask(root, {
        title: "Changes requested task",
        description: "Stay draft after rejection.",
        workflowId: "code-feature",
        source: "manual",
        targets: [{ raw: `@${repoDir}`, path: repoDir, kind: "directory" }]
      });

      const approvedAt = new Date().toISOString();
      await updateTask(root, task.id, (current) => ({
        ...current,
        repoPath: repoDir,
        branch: "harness/test",
        workspacePath: repoDir,
        pushedAt: approvedAt,
        mergeRequest: {
          provider: "github",
          url: "https://github.com/o/r/pull/12",
          number: 12
        },
        workflowRun: {
          ...current.workflowRun!,
          currentStepId: "review",
          completedSteps: ["plan", "plan_gate", "implement", "lint", "unit", "typecheck", "create_merge_request"]
        }
      }));

      await runTaskTurn(root, task.id, {
        runner: new DeterministicAgentRunner("grok"),
        reviewerRunner,
        wait: true
      });
      const updated = await getTask(root, task.id);

      // Routed back to implementation, never completed, MR untouched and still draft.
      expect(updated?.resolution).not.toBe("completed");
      expect(updated?.workflowRun?.currentStepId).toBe("implement");
      expect(updated?.reviewState).toBe("changes_requested");
      expect(updated?.mergeRequest?.number).toBe(12);
      const readyCall = fetchImpl.mock.calls.find(([url]) => url === "https://api.github.com/graphql");
      expect(readyCall).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
