import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runClickUpTicketSync } from "../src/autonomy/handlers/clickup-ticket-sync.ts";
import {
  commentContainsHarnessTrigger,
  textContainsHarnessTrigger
} from "../src/connectors/providers/clickup-markers.ts";
import {
  createClickUpComment,
  isClickUpApiUrl,
  listClickUpTaskComments,
  listClickUpTasks,
  updateClickUpTaskStatus
} from "../src/connectors/providers/clickup-client.ts";
import {
  type ClickUpSyncedTask,
  getClickUpSyncState,
  listSubscribedClickUpListIds,
  updateClickUpSyncState
} from "../src/connectors/providers/clickup-sync-state.ts";
import { saveConnection } from "../src/connectors/store.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { writeJsonFile } from "../src/core/infra/fs.ts";
import { onboardProject } from "../src/core/projects/registry.ts";
import { createTask, deleteTask, listTasks } from "../src/core/tasks/tasks.ts";
import type { HarnessTask } from "../src/core/types.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function connectClickUpList(root: string): Promise<void> {
  await saveConnection(root, {
    id: "conn-clickup",
    providerId: "clickup",
    status: "connected",
    authMethod: "token",
    accountLabel: "Workspace",
    connectedAt: new Date().toISOString(),
    config: { clickup: { subscribedListIds: ["list-1"] } }
  });
}

async function linkClickUpTask(
  root: string,
  clickUpId: string,
  harnessTaskId: string,
  synced?: Partial<ClickUpSyncedTask>
): Promise<void> {
  await connectClickUpList(root);
  await updateClickUpSyncState(root, (state) => ({
    ...state,
    tasks: {
      ...state.tasks,
      [clickUpId]: {
        clickUpTaskId: clickUpId,
        harnessTaskId,
        listId: "list-1",
        triggerSource: "description",
        ...synced
      }
    }
  }));
}

async function persistTask(root: string, task: HarnessTask, overrides: Partial<HarnessTask> = {}): Promise<void> {
  await writeJsonFile(path.join(root, "data", "state", "tasks.json"), [{ ...task, ...overrides }]);
}

function captureClickUpCalls(clickUpId: string, taskName: string): {
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  commentBodies: string[];
  statusUpdates: string[];
} {
  const commentBodies: string[] = [];
  const statusUpdates: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/list/list-1/task")) {
      return json({ tasks: [{ id: clickUpId, name: taskName, date_updated: "2000" }] });
    }
    if (url.includes(`/task/${clickUpId}/comment`) && init?.method === "POST") {
      commentBodies.push(String(init.body));
      return json({ id: "out-1" });
    }
    if (url.includes(`/task/${clickUpId}/comment`)) return json({ comments: [] });
    if (url.includes(`/task/${clickUpId}`) && init?.method === "PUT") {
      statusUpdates.push(String((JSON.parse(String(init.body)) as { status: string }).status));
      return json({});
    }
    return json({});
  };
  return { fetchImpl, commentBodies, statusUpdates };
}

describe("ClickUp polling sync", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-clickup-sync-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  it("detects operator triggers while ignoring harness-authored marker comments", () => {
    expect(textContainsHarnessTrigger("Please @omc implement this")).toBe(true);
    expect(textContainsHarnessTrigger("please @Omc check this")).toBe(true);
    expect(textContainsHarnessTrigger("Please discuss harness design")).toBe(false);

    expect(commentContainsHarnessTrigger({ text: "New detail for @omc", authorId: "u1" }, "bot")).toBe(true);
    expect(commentContainsHarnessTrigger({ text: "Mission Control picked this up", authorId: "bot" }, "bot"))
      .toBe(false);
  });

  it("normalizes legacy single-list ClickUp config into subscribed list ids", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { teamId: "team-1", listId: "legacy-list" } }
    });

    expect(await listSubscribedClickUpListIds(root)).toEqual(["legacy-list"]);
  });

  it("paginates ClickUp tasks with Markdown descriptions and update cursors", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("page=0")) {
        return json({ tasks: Array.from({ length: 100 }, (_, index) => ({ id: `t-${index}`, name: `Task ${index}` })) });
      }
      return json({ tasks: [{ id: "t-100", name: "Task 100", markdown_description: "@omc", date_updated: "2000" }] });
    };

    const tasks = await listClickUpTasks({
      token: "token",
      listId: "list-1",
      dateUpdatedGt: "1000",
      fetchImpl
    });

    expect(tasks).toHaveLength(101);
    expect(calls[0]).toContain("include_markdown_description=true");
    expect(calls[0]).toContain("order_by=updated");
    expect(calls[0]).toContain("date_updated_gt=1000");
    expect(calls[1]).toContain("page=1");
  });

  it("creates one harness task for a tagged ClickUp task and records sync state", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { teamId: "team-1", subscribedListIds: ["list-1"] } }
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({
          tasks: [
            {
              id: "cu-1",
              name: "Fix checkout flow",
              markdown_description: "Please @omc implement the fix.",
              date_updated: "2000",
              url: "https://app.clickup.com/t/cu-1"
            }
          ]
        });
      }
      if (url.includes("/task/cu-1/comment")) return json({ comments: [] });
      return json({});
    };

    const first = await runClickUpTicketSync(root, { token: "token", fetchImpl });
    const second = await runClickUpTicketSync(root, { token: "token", fetchImpl });

    expect(first.summary).toContain("created 1");
    expect(second.summary).toContain("created 0");
    const tasks = await listTasks(root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      source: "clickup",
      title: "Fix checkout flow",
      links: [{ label: "ClickUp cu-1", url: "https://app.clickup.com/t/cu-1" }]
    });
    expect(tasks[0]?.description).toContain("Please @omc implement the fix.");
    const state = await getClickUpSyncState(root);
    expect(state.tasks["cu-1"]?.harnessTaskId).toBe(tasks[0]?.id);
    expect(state.tasks["cu-1"]?.triggerSource).toBe("description");
  });

  it("assigns imported ClickUp tasks to the project bound to the source list", async () => {
    const repoPath = path.join(root, "repos", "project-app");
    execSync(`git init "${repoPath}"`);
    const project = await onboardProject(root, { name: "Project App", repoPath });
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: {
        clickup: {
          subscribedListIds: ["list-1"],
          listProjectBindings: { "list-1": project.id }
        }
      }
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({
          tasks: [{ id: "cu-project", name: "Route to project", markdown_description: "@omc", date_updated: "2000" }]
        });
      }
      if (url.includes("/task/cu-project/comment")) return json({ comments: [] });
      return json({});
    };

    await runClickUpTicketSync(root, { token: "token", fetchImpl });

    const [task] = await listTasks(root);
    expect(task?.projectId).toBe(project.id);
    expect(task?.repoPath).toBe(project.repoPath);
    expect(task?.targets).toEqual([{ raw: `@${project.repoPath}`, path: project.repoPath, kind: "directory" }]);
  });

  it("includes the triggering comment when a ClickUp task is ingested from comments", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({ tasks: [{ id: "cu-comment", name: "Comment only request", date_updated: "2000" }] });
      }
      if (url.includes("/task/cu-comment/comment")) {
        return json({ comments: [{ id: "c-trigger", comment_text: "@omc build the export", date: "1900" }] });
      }
      return json({});
    };

    await runClickUpTicketSync(root, { token: "token", fetchImpl });

    const [task] = await listTasks(root);
    expect(task?.description).toContain("ClickUp trigger comment c-trigger");
    expect(task?.description).toContain("@omc build the export");
    expect((await getClickUpSyncState(root)).tasks["cu-comment"]?.triggerSource).toBe("comment");
  });

  it("scans existing list tasks for comment-only triggers even when the list cursor is newer", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });
    await updateClickUpSyncState(root, (state) => ({
      ...state,
      listCursors: { "list-1": "9000" }
    }));

    let listTaskUrl = "";
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        listTaskUrl = url;
        if (url.includes("date_updated_gt")) return json({ tasks: [] });
        return json({ tasks: [{ id: "cu-old", name: "Old task", date_updated: "1000" }] });
      }
      if (url.includes("/task/cu-old/comment")) {
        return json({ comments: [{ id: "c-old", comment_text: "@omc take over this task", date: "9500" }] });
      }
      return json({});
    };

    const result = await runClickUpTicketSync(root, { token: "token", fetchImpl });

    expect(listTaskUrl).not.toContain("date_updated_gt");
    expect(result.summary).toContain("tasks 1");
    expect(result.summary).toContain("created 1");
    const [task] = await listTasks(root);
    expect(task?.title).toBe("Old task");
    expect(task?.description).toContain("@omc take over this task");
    expect((await getClickUpSyncState(root)).tasks["cu-old"]?.triggerSource).toBe("comment");
  });

  it("turns tagged comments on managed ClickUp tasks into harness operator messages", async () => {
    const task = await createTask(root, {
      title: "Managed task",
      description: "Existing managed task",
      source: "clickup",
      links: []
    });
    await updateClickUpSyncState(root, (state) => ({
      ...state,
      tasks: {
        "cu-2": {
          clickUpTaskId: "cu-2",
          harnessTaskId: task.id,
          listId: "list-1",
          taskUrl: "https://app.clickup.com/t/cu-2",
          lastSeenUpdatedAt: "1000",
          lastProcessedCommentAt: "0",
          triggerSource: "description"
        }
      }
    }));
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({ tasks: [{ id: "cu-2", name: "Managed task", date_updated: "3000" }] });
      }
      if (url.includes("/task/cu-2/comment")) {
        return json({ comments: [{ id: "c-1", comment_text: "@omc use the new API", date: "2500", user: { id: 42 } }] });
      }
      return json({});
    };

    const result = await runClickUpTicketSync(root, { token: "token", fetchImpl });

    expect(result.summary).toContain("comments 1");
    const [updated] = await listTasks(root);
    expect(updated?.messages.at(-1)).toMatchObject({
      author: "operator",
      body: expect.stringContaining("@omc use the new API")
    });
    expect((await getClickUpSyncState(root)).tasks["cu-2"]?.lastProcessedCommentAt).toBe("2500");
  });

  it("posts the Mission Control pickup comment once when work begins", async () => {
    const task = await createTask(root, {
      title: "Pickup",
      description: "Triggered ticket",
      source: "clickup",
      links: []
    });
    await persistTask(root, task, { startedAt: "2026-06-19T09:00:00.000Z" });
    await linkClickUpTask(root, "cu-pickup", task.id);
    const capture = captureClickUpCalls("cu-pickup", "Pickup");

    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });
    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });

    expect(capture.commentBodies).toHaveLength(1);
    expect(capture.commentBodies[0]).toContain("Mission Control picked up this ticket");
    expect(capture.commentBodies[0]).not.toContain("harness:clickup-sync");
  });

  it("does not fail or spam when ClickUp rejects a mapped status", async () => {
    const task = await createTask(root, {
      title: "Rejected status",
      description: "Triggered ticket",
      source: "clickup",
      links: []
    });
    await persistTask(root, task, { startedAt: "2026-06-19T09:00:00.000Z" });
    await linkClickUpTask(root, "cu-reject-status", task.id);
    const capture = captureClickUpCalls("cu-reject-status", "Rejected status");
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/task/cu-reject-status") && init?.method === "PUT") {
        capture.statusUpdates.push(String((JSON.parse(String(init.body)) as { status: string }).status));
        return json({ err: "Status is invalid" }, 400);
      }
      return capture.fetchImpl(input, init);
    };

    const first = await runClickUpTicketSync(root, { token: "token", fetchImpl });
    const second = await runClickUpTicketSync(root, { token: "token", fetchImpl });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(capture.statusUpdates).toEqual(["in progress"]);
    expect(capture.commentBodies).toHaveLength(1);
    expect(capture.commentBodies[0]).toContain("Mission Control picked up this ticket");
    expect((await getClickUpSyncState(root)).tasks["cu-reject-status"]).toMatchObject({
      lastRejectedStatus: "in progress",
      pickedUpCommentPosted: true
    });
  });

  it("posts a single completion comment carrying the merge request link", async () => {
    const task = await createTask(root, {
      title: "Done with MR",
      description: "Triggered ticket",
      source: "clickup",
      links: []
    });
    await persistTask(root, task, {
      resolution: "completed",
      mergeRequest: { provider: "github", url: "https://github.com/acme/repo/pull/9", number: 9 },
      pushedAt: "2026-06-19T10:00:00.000Z"
    });
    await linkClickUpTask(root, "cu-done", task.id, { pickedUpCommentPosted: true });
    const capture = captureClickUpCalls("cu-done", "Done with MR");

    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });
    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });

    expect(capture.commentBodies).toHaveLength(1);
    expect(capture.commentBodies[0]).toContain("Mission Control completed this ticket");
    expect(capture.commentBodies[0]).toContain("PR: https://github.com/acme/repo/pull/9");
    expect(capture.commentBodies[0]).not.toContain("harness:clickup-sync");
  });

  it("posts a plain completion comment when finished without a merge request", async () => {
    const task = await createTask(root, {
      title: "Done no MR",
      description: "Triggered ticket",
      source: "clickup",
      links: []
    });
    await persistTask(root, task, { resolution: "completed" });
    await linkClickUpTask(root, "cu-nomr", task.id, { pickedUpCommentPosted: true });
    const capture = captureClickUpCalls("cu-nomr", "Done no MR");

    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });

    expect(capture.commentBodies).toHaveLength(1);
    expect(capture.commentBodies[0]).toContain("Mission Control completed this ticket");
    expect(capture.commentBodies[0]).not.toContain("PR:");
    expect(capture.commentBodies[0]).not.toContain("MR:");
  });

  it("posts no comment when a managed ticket is blocked", async () => {
    const task = await createTask(root, {
      title: "Blocked",
      description: "Triggered ticket",
      source: "clickup",
      links: []
    });
    await persistTask(root, task, { blockedReason: "waiting on environment" });
    await linkClickUpTask(root, "cu-blocked", task.id, { pickedUpCommentPosted: true });
    const capture = captureClickUpCalls("cu-blocked", "Blocked");

    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });

    expect(capture.commentBodies).toHaveLength(0);
  });

  it("does not resend status or comments when only the merge request link appears", async () => {
    const task = await createTask(root, {
      title: "Status dedup",
      description: "Triggered ticket",
      source: "clickup",
      links: []
    });
    await persistTask(root, task, {
      mergeRequest: { provider: "github", url: "https://github.com/acme/repo/pull/9", number: 9 },
      pushedAt: "2026-06-19T10:00:00.000Z"
    });
    await linkClickUpTask(root, "cu-dedup", task.id, {
      pickedUpCommentPosted: true,
      lastPostedStatus: "in progress"
    });
    const capture = captureClickUpCalls("cu-dedup", "Status dedup");

    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });

    expect(capture.statusUpdates).toHaveLength(0);
    expect(capture.commentBodies).toHaveLength(0);
  });

  it("does not re-announce pickup for tickets first synced before the comment change", async () => {
    const task = await createTask(root, {
      title: "Legacy",
      description: "Triggered ticket",
      source: "clickup",
      links: []
    });
    await persistTask(root, task, { startedAt: "2026-06-19T09:00:00.000Z" });
    await linkClickUpTask(root, "cu-legacy", task.id, { lastOutboundFingerprint: "in progress||legacy" });
    const capture = captureClickUpCalls("cu-legacy", "Legacy");

    await runClickUpTicketSync(root, { token: "token", fetchImpl: capture.fetchImpl });

    expect(capture.commentBodies).toHaveLength(0);
  });

  it("wraps ClickUp rate limits as blocked autonomy results", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    const result = await runClickUpTicketSync(root, {
      token: "token",
      fetchImpl: async () => json({ err: "rate limit" }, 429)
    });

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("rate limited");
  });

  it("updates ClickUp task status with the documented payload shape", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return json({});
    };

    await updateClickUpTaskStatus({ token: "token", taskId: "cu-4", status: "in progress", fetchImpl });
    await createClickUpComment({ token: "token", taskId: "cu-4", text: "hello", fetchImpl });
    await listClickUpTaskComments({ token: "token", taskId: "cu-4", fetchImpl });

    expect(calls[0]).toMatchObject({ url: "https://api.clickup.com/api/v2/task/cu-4" });
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ status: "in progress" }));
    expect(calls[1]).toMatchObject({ url: "https://api.clickup.com/api/v2/task/cu-4/comment" });
    expect(calls[2]).toMatchObject({ url: "https://api.clickup.com/api/v2/task/cu-4/comment" });
  });

  it("imports ClickUp attachments onto the created task and dedups across syncs", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    const attachmentBytes = Buffer.from("%PDF-1.4 clickup brief");
    const downloadCalls: string[] = [];
    const fetchImpl = async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({
          tasks: [
            {
              id: "cu-att",
              name: "Ship the brief",
              markdown_description: "Please @omc build this.",
              date_updated: "2000"
            }
          ]
        });
      }
      if (url.includes("/task/cu-att/comment")) return json({ comments: [] });
      // ClickUp exposes no GET list-attachments endpoint on v2; attachments are
      // returned on the Get Task response. Match the exact Get Task URL so a
      // regression to /task/{id}/attachment falls through to json({}) and yields [].
      if (url === "https://api.clickup.com/api/v2/task/cu-att") {
        return json({
          id: "cu-att",
          name: "Ship the brief",
          attachments: [{ id: "att-1", title: "brief.pdf", url: "https://clickup.example/brief.pdf" }]
        });
      }
      if (url === "https://clickup.example/brief.pdf") {
        downloadCalls.push(url);
        return new Response(attachmentBytes, { status: 200 });
      }
      return json({});
    };

    await runClickUpTicketSync(root, { token: "token", fetchImpl });

    const tasks = await listTasks(root);
    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task?.attachments).toHaveLength(1);
    expect(task?.attachments?.[0]).toMatchObject({
      filename: "brief.pdf",
      source: "clickup",
      sourceUrl: "https://clickup.example/brief.pdf",
      sourceKey: "clickup:cu-att:att-1"
    });

    // Re-syncing the now-managed task must not re-download or duplicate.
    await runClickUpTicketSync(root, { token: "token", fetchImpl });
    const [reloaded] = await listTasks(root);
    expect(reloaded?.attachments).toHaveLength(1);
    expect(downloadCalls).toHaveLength(1);
  });

  it("skips a stale mapping whose local task was deleted instead of failing the sync", async () => {
    await connectClickUpList(root);

    // Seed a managed mapping, then delete the local task so the mapping is stale.
    const created = await createTask(root, {
      title: "Gone",
      description: "deleted local task",
      source: "clickup"
    });
    await linkClickUpTask(root, "cu-stale", created.id);
    await deleteTask(root, created.id);

    const downloadCalls: string[] = [];
    const fetchImpl = async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({
          tasks: [
            {
              id: "cu-stale",
              name: "Gone",
              markdown_description: "Please @omc build this.",
              date_updated: "2000"
            }
          ]
        });
      }
      if (url.includes("/task/cu-stale/comment")) return json({ comments: [] });
      if (url === "https://api.clickup.com/api/v2/task/cu-stale") {
        return json({
          id: "cu-stale",
          name: "Gone",
          attachments: [{ id: "att-stale", title: "brief.pdf", url: "https://clickup.example/stale.pdf" }]
        });
      }
      if (url === "https://clickup.example/stale.pdf") {
        downloadCalls.push(url);
        return new Response(Buffer.from("%PDF-1.4 stale brief"), { status: 200 });
      }
      return json({});
    };

    // The stale mapping is skipped, not fatal: sync resolves rather than throwing.
    await expect(runClickUpTicketSync(root, { token: "token", fetchImpl })).resolves.toBeDefined();

    // The deleted local task stays gone, and its attachment is never downloaded.
    const tasks = await listTasks(root);
    expect(tasks).toHaveLength(0);
    expect(downloadCalls).toHaveLength(0);
  });

  it("does not forward the ClickUp token to non-API attachment download hosts", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    const downloadHeaders: Array<Record<string, string>> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({
          tasks: [
            {
              id: "cu-leak",
              name: "Token leak check",
              markdown_description: "Please @omc build this.",
              date_updated: "2000"
            }
          ]
        });
      }
      if (url.includes("/task/cu-leak/comment")) return json({ comments: [] });
      if (url === "https://api.clickup.com/api/v2/task/cu-leak") {
        return json({
          id: "cu-leak",
          name: "Token leak check",
          // Signed/public CDN-style links are the common case and must never
          // receive the operator token.
          attachments: [{ id: "att-leak", title: "brief.pdf", url: "https://cdn.example.com/signed/brief.pdf" }]
        });
      }
      if (url === "https://cdn.example.com/signed/brief.pdf") {
        downloadHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(Buffer.from("%PDF-1.4 leak check"), { status: 200 });
      }
      return json({});
    };

    await runClickUpTicketSync(root, { token: "secret-operator-token", fetchImpl });

    expect(downloadHeaders).toHaveLength(1);
    const header = downloadHeaders[0];
    expect(header?.["Authorization"] ?? header?.["authorization"]).toBeUndefined();
    const [task] = await listTasks(root);
    expect(task?.attachments).toHaveLength(1);
  });

  it("forwards the ClickUp token only when the attachment URL is the API origin", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    const downloadHeaders: Array<Record<string, string>> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({
          tasks: [
            {
              id: "cu-authed",
              name: "Authed download check",
              markdown_description: "Please @omc build this.",
              date_updated: "2000"
            }
          ]
        });
      }
      if (url.includes("/task/cu-authed/comment")) return json({ comments: [] });
      if (url === "https://api.clickup.com/api/v2/task/cu-authed") {
        return json({
          id: "cu-authed",
          name: "Authed download check",
          attachments: [
            { id: "att-authed", title: "brief.pdf", url: "https://api.clickup.com/api/v2/task/cu-authed/attachment/att-authed/download" }
          ]
        });
      }
      if (url === "https://api.clickup.com/api/v2/task/cu-authed/attachment/att-authed/download") {
        downloadHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(Buffer.from("%PDF-1.4 authed brief"), { status: 200 });
      }
      return json({});
    };

    await runClickUpTicketSync(root, { token: "secret-operator-token", fetchImpl });

    expect(downloadHeaders).toHaveLength(1);
    expect(downloadHeaders[0]?.["Authorization"]).toBe("secret-operator-token");
  });

  function transientFetchError(): TypeError {
    // Mirror undici's real shape: `TypeError: fetch failed` whose `cause` is the
    // underlying Node system error carrying `code`/`syscall` (errno -60 here,
    // the exact failure the daemon logs during the autonomy loop).
    return Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "read" })
    });
  }

  it("retries transient ClickUp transport failures before giving up", async () => {
    let attempts = 0;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/task/cu-retry/comment")) {
        attempts += 1;
        if (attempts < 3) throw transientFetchError();
        return json({ comments: [{ id: "c-1", comment_text: "hi", date: "1" }] });
      }
      return json({});
    };

    const comments = await listClickUpTaskComments({
      token: "token",
      taskId: "cu-retry",
      fetchImpl,
      retry: { maxAttempts: 4, baseDelayMs: 0 }
    });

    expect(comments).toHaveLength(1);
    expect(attempts).toBe(3);
  });

  it("does not retry non-transient ClickUp fetch errors", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw new TypeError("genuinely broken");
    };

    await expect(
      listClickUpTaskComments({
        token: "token",
        taskId: "cu-hard",
        fetchImpl,
        retry: { maxAttempts: 4, baseDelayMs: 0 }
      })
    ).rejects.toThrow("genuinely broken");
    expect(attempts).toBe(1);
  });

  it("does not retry ClickUp rate-limit responses at the transport layer", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return json({ err: "rate limit" }, 429);
    };

    await expect(
      listClickUpTaskComments({
        token: "token",
        taskId: "cu-429",
        fetchImpl,
        retry: { maxAttempts: 4, baseDelayMs: 0 }
      })
    ).rejects.toThrow(/rate limit/i);
    expect(attempts).toBe(1);
  });

  it("does not retry comment creation so a non-idempotent POST cannot duplicate comments", async () => {
    // A read timeout can land after ClickUp has accepted the POST but before the
    // client sees the response. Retrying would then post the comment twice. The
    // POST must stay single-attempt even under a transient transport failure.
    let attempts = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/task/cu-dup/comment") && init?.method === "POST") {
        attempts += 1;
        throw transientFetchError();
      }
      return json({});
    };

    await expect(
      createClickUpComment({ token: "token", taskId: "cu-dup", text: "once only", fetchImpl })
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("completes the sync when one task's comment fetch fails transiently, deferring that task", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    let flakyAttempts = 0;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({
          tasks: [
            { id: "cu-flaky", name: "Flaky", date_updated: "2000" },
            { id: "cu-ok", name: "Ok", markdown_description: "@omc", date_updated: "2000" }
          ]
        });
      }
      if (url.includes("/task/cu-flaky/comment")) {
        flakyAttempts += 1;
        throw transientFetchError();
      }
      if (url.includes("/task/cu-ok/comment")) return json({ comments: [] });
      return json({});
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runClickUpTicketSync(root, {
      token: "token",
      fetchImpl,
      retry: { maxAttempts: 2, baseDelayMs: 0 }
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("transiently");
    // The flaky task's comments were retried then deferred to the next interval;
    // the subsequent task still synced, proving the whole job did not abort.
    expect(flakyAttempts).toBe(2);
    const tasks = await listTasks(root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Ok");
    expect(warnSpy).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });

  it("still fails the sync when a comment fetch returns a durable ClickUp API error", async () => {
    await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: { clickup: { subscribedListIds: ["list-1"] } }
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/list/list-1/task")) {
        return json({ tasks: [{ id: "cu-auth", name: "Auth", date_updated: "2000" }] });
      }
      if (url.includes("/task/cu-auth/comment")) return json({ err: "unauthorized" }, 401);
      return json({});
    };

    await expect(
      runClickUpTicketSync(root, { token: "token", fetchImpl, retry: { maxAttempts: 3, baseDelayMs: 0 } })
    ).rejects.toThrow(/401/);
  });

  it("classifies ClickUp API origins for attachment authentication", () => {
    expect(isClickUpApiUrl("https://api.clickup.com/api/v2/task/abc")).toBe(true);
    expect(isClickUpApiUrl("https://api.clickup.com/anything")).toBe(true);
    // Signed/public CDN and app hosts are not the API origin.
    expect(isClickUpApiUrl("https://attachments.clickup.com/file.pdf")).toBe(false);
    expect(isClickUpApiUrl("https://app.clickup.com/t/abc")).toBe(false);
    expect(isClickUpApiUrl("https://cdn.example.com/signed/brief.pdf")).toBe(false);
    // Plain http on the API host is still rejected.
    expect(isClickUpApiUrl("http://api.clickup.com/api/v2/task/abc")).toBe(false);
    // Look-alike hosts must not match.
    expect(isClickUpApiUrl("https://api.clickup.com.evil.com/api/v2/task/abc")).toBe(false);
    // Malformed URLs are treated as non-API rather than throwing.
    expect(isClickUpApiUrl("not a url")).toBe(false);
  });
});
