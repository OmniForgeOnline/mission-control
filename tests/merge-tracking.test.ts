import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectWithToken } from "../src/connectors/connections.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks/tasks.ts";
import {
  refreshMergeStates,
  refreshTaskMergeState
} from "../src/core/tasks/merge-tracking.ts";
import type { HarnessTask } from "../src/core/types.ts";

type Provider = "github" | "gitlab";

async function makeRepoDir(remoteUrl: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-merge-track-repo-"));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  return dir;
}

async function makePendingTask(
  root: string,
  provider: Provider,
  repoDir: string,
  number: number
): Promise<HarnessTask> {
  const url =
    provider === "github"
      ? `https://github.com/acme/repo/pull/${number}`
      : `https://gitlab.com/group/project/-/merge_requests/${number}`;
  const task = await createTask(root, {
    title: `Merge track ${provider} ${number}`,
    description: "desc",
    workflowId: "code-feature",
    source: "manual"
  });
  return updateTask(root, task.id, (current) => ({
    ...current,
    repoPath: repoDir,
    mergeRequest: { provider, url, number }
  }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes the account-lookup and PR/MR endpoints for one provider. Returns the mock. */
function stubProviderFetch(
  provider: Provider,
  routes: Record<number, { body: unknown; status?: number }>
): ReturnType<typeof vi.fn> {
  const accountUrl =
    provider === "github" ? "https://api.github.com/user" : "https://gitlab.com/api/v4/user";
  const segment = provider === "github" ? "/pulls/" : "/merge_requests/";
  const fetchMock = vi.fn(async (url: string) => {
    if (url === accountUrl) {
      return jsonResponse(provider === "github" ? { login: "octocat" } : { username: "octouser" });
    }
    const idx = String(url).indexOf(segment);
    if (idx >= 0) {
      const num = Number(String(url).slice(idx + segment.length).split("?")[0]);
      const route = routes[num];
      if (route) return jsonResponse(route.body, route.status ?? 200);
    }
    return jsonResponse({ message: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("merge-state refresh", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-merge-track-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  async function setup(provider: Provider, number: number, remoteUrl: string) {
    await connectWithToken(root, provider, provider === "github" ? "ghp_token" : "glpat_token");
    const repoDir = await makeRepoDir(remoteUrl);
    return makePendingTask(root, provider, repoDir, number);
  }

  it("completes the ticket when GitHub reports the PR merged", async () => {
    stubProviderFetch("github", { 7: { body: { state: "closed", merged: true } } });
    const task = await setup("github", 7, "https://github.com/acme/repo.git");

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("merged");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBe("completed");
    expect(persisted?.completedAt).toBeDefined();
    expect(persisted?.mergeRequest?.state).toBe("merged");
    expect(persisted?.mergeRequest?.mergedAt).toBeDefined();
    expect(persisted?.mergeRequest?.checkedAt).toBeDefined();
  });

  it("keeps the ticket pending when the GitHub PR is still open", async () => {
    stubProviderFetch("github", { 8: { body: { state: "open", merged: false } } });
    const task = await setup("github", 8, "https://github.com/acme/repo.git");

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("open");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBeUndefined();
    expect(persisted?.mergeRequest?.state).toBe("open");
    expect(persisted?.mergeRequest?.mergedAt).toBeUndefined();
    expect(persisted?.mergeRequest?.checkedAt).toBeDefined();
  });

  it("completes the ticket when GitLab reports the MR merged", async () => {
    stubProviderFetch("gitlab", { 12: { body: { state: "merged" } } });
    const task = await setup("gitlab", 12, "https://gitlab.com/group/project.git");

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("merged");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBe("completed");
    expect(persisted?.mergeRequest?.state).toBe("merged");
    expect(persisted?.mergeRequest?.mergedAt).toBeDefined();
  });

  it("keeps the ticket pending when the GitLab MR is still opened", async () => {
    stubProviderFetch("gitlab", { 13: { body: { state: "opened" } } });
    const task = await setup("gitlab", 13, "https://gitlab.com/group/project.git");

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("open");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBeUndefined();
    expect(persisted?.mergeRequest?.state).toBe("open");
  });

  it("leaves closed-without-merge actionable and recorded as closed", async () => {
    stubProviderFetch("github", { 9: { body: { state: "closed", merged: false } } });
    const task = await setup("github", 9, "https://github.com/acme/repo.git");

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("closed");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBeUndefined();
    expect(persisted?.mergeRequest?.state).toBe("closed");
    expect(persisted?.mergeRequest?.mergedAt).toBeUndefined();
  });

  it("clears a stale completed resolution when the GitHub PR is still open", async () => {
    stubProviderFetch("github", { 31: { body: { state: "open", merged: false } } });
    const task = await setup("github", 31, "https://github.com/acme/repo.git");
    // Simulate the premature terminal handoff that marks the ticket completed before
    // the MR/PR has actually landed on the forge.
    await updateTask(root, task.id, (current) => ({
      ...current,
      resolution: "completed",
      completedAt: "2026-01-01T00:00:00.000Z"
    }));

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("open");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBeUndefined();
    expect(persisted?.completedAt).toBeUndefined();
    expect(persisted?.mergeRequest?.state).toBe("open");
  });

  it("clears a stale completed resolution when the GitLab MR is closed without merge", async () => {
    stubProviderFetch("gitlab", { 32: { body: { state: "closed" } } });
    const task = await setup("gitlab", 32, "https://gitlab.com/group/project.git");
    await updateTask(root, task.id, (current) => ({
      ...current,
      resolution: "completed",
      completedAt: "2026-01-01T00:00:00.000Z"
    }));

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("closed");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBeUndefined();
    expect(persisted?.completedAt).toBeUndefined();
    expect(persisted?.mergeRequest?.state).toBe("closed");
  });

  it("preserves a stale completed resolution when the forge state is unknown", async () => {
    stubProviderFetch("github", { 33: { body: { message: "rate limited" }, status: 403 } });
    const task = await setup("github", 33, "https://github.com/acme/repo.git");
    await updateTask(root, task.id, (current) => ({
      ...current,
      resolution: "completed",
      completedAt: "2026-01-01T00:00:00.000Z"
    }));

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("unknown");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBe("completed");
    expect(persisted?.completedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("records unknown and does not complete when the forge errors", async () => {
    stubProviderFetch("github", { 10: { body: { message: "rate limited" }, status: 403 } });
    const task = await setup("github", 10, "https://github.com/acme/repo.git");

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("unknown");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBeUndefined();
    expect(persisted?.mergeRequest?.mergedAt).toBeUndefined();
  });

  it("skips tasks without a pending merge request", async () => {
    const task = await createTask(root, {
      title: "No MR",
      description: "desc",
      workflowId: "code-feature",
      source: "manual"
    });
    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("skipped");
  });

  it("summarizes outcomes across many tasks", async () => {
    stubProviderFetch("github", {
      21: { body: { state: "closed", merged: true } },
      22: { body: { state: "open", merged: false } },
      23: { body: { state: "closed", merged: false } }
    });
    await connectWithToken(root, "github", "ghp_token");
    const repoDir = await makeRepoDir("https://github.com/acme/repo.git");
    const merged = await makePendingTask(root, "github", repoDir, 21);
    const open = await makePendingTask(root, "github", repoDir, 22);
    const closed = await makePendingTask(root, "github", repoDir, 23);

    const summary = await refreshMergeStates(root, [merged, open, closed]);
    expect(summary).toEqual({ scanned: 3, merged: 1, open: 1, closed: 1, unknown: 0 });

    expect((await getTask(root, merged.id))?.resolution).toBe("completed");
    expect((await getTask(root, open.id))?.resolution).toBeUndefined();
  });

  it("self-heals a task whose merge another sweep already recorded, without a forge poll", async () => {
    // The worktree-cleanup sweep stamps mergeRequest.mergedAt when it confirms a merge
    // but does not advance the task to completion. Such a task is no longer merge-pending,
    // so the refresh must self-heal it to completed from the recorded merge time rather
    // than skip it forever (which would leave persisted completion state unset).
    const fetchMock = stubProviderFetch("github", { 41: { body: { message: "no" }, status: 404 } });
    await connectWithToken(root, "github", "ghp_token");
    const repoDir = await makeRepoDir("https://github.com/acme/repo.git");
    const pending = await makePendingTask(root, "github", repoDir, 41);
    const task = await updateTask(root, pending.id, (current) => ({
      ...current,
      mergeRequest: { ...current.mergeRequest!, mergedAt: "2026-02-01T00:00:00.000Z" }
    }));

    const result = await refreshTaskMergeState(root, task);
    expect(result.outcome).toBe("merged");

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBe("completed");
    expect(persisted?.completedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(persisted?.mergeRequest?.mergedAt).toBe("2026-02-01T00:00:00.000Z");

    // Self-heal must not re-poll the forge for a merge it can already see was recorded.
    const prHits = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/pulls/41"));
    expect(prHits).toHaveLength(0);
  });

  it("does not skip merged-but-unresolved tasks across the sweep", async () => {
    const fetchMock = stubProviderFetch("github", { 42: { body: { message: "no" }, status: 404 } });
    await connectWithToken(root, "github", "ghp_token");
    const repoDir = await makeRepoDir("https://github.com/acme/repo.git");
    const pending = await makePendingTask(root, "github", repoDir, 42);
    const task = await updateTask(root, pending.id, (current) => ({
      ...current,
      mergeRequest: { ...current.mergeRequest!, mergedAt: "2026-02-02T00:00:00.000Z" }
    }));

    const summary = await refreshMergeStates(root, [task]);
    expect(summary).toEqual({ scanned: 1, merged: 1, open: 0, closed: 0, unknown: 0 });

    const persisted = await getTask(root, task.id);
    expect(persisted?.resolution).toBe("completed");

    const prHits = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/pulls/42"));
    expect(prHits).toHaveLength(0);
  });
});
