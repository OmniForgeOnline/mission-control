import { getProviderAccessToken } from "../../connectors/connections.ts";
import {
  ClickUpApiError,
  ClickUpRateLimitError,
  createClickUpComment,
  describeNetworkError,
  isClickUpApiUrl,
  isTransientNetworkError,
  listClickUpTaskAttachments,
  listClickUpTaskComments,
  listClickUpTasks,
  updateClickUpTaskStatus,
  type ClickUpAttachment,
  type ClickUpRetryOptions,
  type ClickUpTaskComment,
  type ClickUpTaskSummary
} from "../../connectors/providers/clickup-client.ts";
import {
  commentContainsHarnessTrigger,
  textContainsHarnessTrigger
} from "../../connectors/providers/clickup-markers.ts";
import {
  getClickUpSyncState,
  getClickUpListProjectBinding,
  listSubscribedClickUpListIds,
  updateClickUpSyncState,
  type ClickUpSyncedTask,
  type ClickUpSyncState
} from "../../connectors/providers/clickup-sync-state.ts";
import { getProject } from "../../core/projects/registry.ts";
import { addTaskMessage, createTask, getTask, updateTask } from "../../core/tasks/tasks.ts";
import { effectivePmStatus } from "../../core/tasks/status.ts";
import { loadWorkflow } from "../../core/workflows/index.ts";
import {
  findAttachmentBySourceKey,
  saveRemoteAttachment
} from "../../core/attachments/store.ts";
import type { AutonomyRunResult } from "../job-types.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { HarnessAttachment, HarnessTarget, HarnessTask, PmStatus } from "../../core/types.ts";

type FetchLike = typeof fetch;

interface ClickUpSyncOptions {
  token?: string;
  fetchImpl?: FetchLike;
  integrationUserId?: string;
  retry?: ClickUpRetryOptions;
}

interface SyncStats {
  lists: number;
  tasks: number;
  created: number;
  comments: number;
  outbound: number;
  /** Tasks whose comment fetch failed transiently even after retries and were
   * deferred to the next polling interval rather than aborting the sync. */
  commentFetchFailures: number;
}

export async function runClickUpTicketSync(
  root: string,
  options?: AutonomyJobContext | ClickUpSyncOptions
): Promise<AutonomyRunResult> {
  const syncOptions = isClickUpSyncOptions(options) ? options : {};
  try {
    const token = syncOptions.token ?? await getProviderAccessToken(root, "clickup");
    if (!token) {
      return blocked("ClickUp sync blocked: no connected ClickUp token.");
    }
    const listIds = await listSubscribedClickUpListIds(root);
    if (listIds.length === 0) {
      return completed("ClickUp sync completed: no subscribed lists.", emptyStats());
    }

    const stats = emptyStats();
    for (const listId of listIds) {
      await syncList(root, { token, listId, ...optionalSyncDeps(syncOptions) }, stats);
    }
    return completed(
      `ClickUp sync completed: lists ${stats.lists}, tasks ${stats.tasks}, created ${stats.created}, comments ${stats.comments}, outbound ${stats.outbound}.`,
      stats
    );
  } catch (error) {
    if (error instanceof ClickUpRateLimitError) {
      return blocked("ClickUp sync rate limited by ClickUp; retry on the next polling interval.");
    }
    throw error;
  }
}

function isClickUpSyncOptions(options: AutonomyJobContext | ClickUpSyncOptions | undefined): options is ClickUpSyncOptions {
  return Boolean(
    options && ("token" in options || "fetchImpl" in options || "integrationUserId" in options || "retry" in options)
  );
}

function optionalSyncDeps(
  options: ClickUpSyncOptions
): { fetchImpl?: FetchLike; integrationUserId?: string; retry?: ClickUpRetryOptions } {
  return {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.integrationUserId ? { integrationUserId: options.integrationUserId } : {}),
    ...(options.retry ? { retry: options.retry } : {})
  };
}

function emptyStats(): SyncStats {
  return { lists: 0, tasks: 0, created: 0, comments: 0, outbound: 0, commentFetchFailures: 0 };
}

interface ClickUpSyncDeps {
  token: string;
  fetchImpl?: FetchLike;
  integrationUserId?: string;
  retry?: ClickUpRetryOptions;
}

async function syncList(
  root: string,
  options: ClickUpSyncDeps & { listId: string },
  stats: SyncStats
): Promise<void> {
  const before = await getClickUpSyncState(root);
  const tasks = await listClickUpTasks({
    token: options.token,
    listId: options.listId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {})
  });
  stats.lists += 1;
  stats.tasks += tasks.length;
  let maxUpdated = before.listCursors[options.listId] ?? "0";
  for (const task of tasks) {
    if (Number(task.date_updated ?? 0) > Number(maxUpdated)) {
      maxUpdated = task.date_updated ?? maxUpdated;
    }
    await syncClickUpTask(root, options, task, stats);
  }
  await updateClickUpSyncState(root, (state) => ({
    ...state,
    listCursors: { ...state.listCursors, [options.listId]: maxUpdated }
  }));
}

async function syncClickUpTask(
  root: string,
  options: ClickUpSyncDeps & { listId: string },
  task: ClickUpTaskSummary,
  stats: SyncStats
): Promise<void> {
  let comments: ClickUpTaskComment[];
  try {
    comments = await listClickUpTaskComments({
      token: options.token,
      taskId: task.id,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.retry ? { retry: options.retry } : {})
    });
  } catch (error) {
    // A transient transport failure (e.g. `read ETIMEDOUT`) must not abort the
    // whole list. After the client exhausts its retries, defer this one task to
    // the next polling interval and keep syncing the rest. Durable failures
    // (auth, malformed request) are not transient and still propagate.
    if (!isTransientNetworkError(error)) throw error;
    stats.commentFetchFailures += 1;
    console.warn(
      `harness:clickup-sync list ${options.listId} task ${task.id} comment fetch failed transiently ` +
        `(${describeNetworkError(error)}); deferring to next interval.`,
      error
    );
    return;
  }
  const state = await getClickUpSyncState(root);
  const existing = state.tasks[task.id];
  if (existing) {
    const added = await importNewTriggeredComments(root, existing, comments, options.integrationUserId);
    stats.comments += added;
    const outbound = await pushOutbound(root, options.token, task.id, existing, options.fetchImpl);
    stats.outbound += outbound;
    await syncTaskAttachments(root, options, task.id, existing.harnessTaskId);
    return;
  }

  const description = task.markdown_description ?? task.text_content ?? task.description ?? "";
  const triggerComment = comments.find((comment) =>
    commentContainsHarnessTrigger(
      { text: comment.text, ...(comment.authorId ? { authorId: comment.authorId } : {}) },
      options.integrationUserId
    )
  );
  const triggerSource = textContainsHarnessTrigger(description) ? "description" : triggerComment ? "comment" : null;
  if (!triggerSource) return;

  const importedAttachments = await importClickUpAttachments(root, options, task.id);
  const attachmentIds = importedAttachments.map((attachment) => attachment.id);

  const created = await createTask(root, {
    title: task.name,
    description: buildHarnessTaskDescription(task, description, triggerComment),
    source: "clickup",
    links: task.url ? [{ label: `ClickUp ${task.id}`, url: task.url }] : [],
    ...(await projectAssignmentForList(root, options.listId)),
    ...(attachmentIds.length ? { attachmentIds } : {})
  });
  await updateClickUpSyncState(root, (current) => ({
    ...current,
    tasks: {
      ...current.tasks,
      [task.id]: {
        clickUpTaskId: task.id,
        harnessTaskId: created.id,
        listId: options.listId,
        ...(task.url ? { taskUrl: task.url } : {}),
        ...(task.date_updated ? { lastSeenUpdatedAt: task.date_updated } : {}),
        ...(triggerComment ? { lastProcessedCommentAt: triggerComment.date } : {}),
        triggerSource
      }
    }
  }));
  stats.created += 1;
}

async function projectAssignmentForList(root: string, listId: string): Promise<{
  projectId?: string;
  repoPath?: string;
  targets?: HarnessTarget[];
}> {
  const projectId = await getClickUpListProjectBinding(root, listId);
  if (!projectId) return {};
  const project = await getProject(root, projectId);
  if (!project || project.status !== "active") return {};
  return {
    projectId: project.id,
    repoPath: project.repoPath,
    targets: [{ raw: `@${project.repoPath}`, path: project.repoPath, kind: "directory" }]
  };
}

function buildHarnessTaskDescription(
  task: ClickUpTaskSummary,
  body: string,
  triggerComment?: ClickUpTaskComment
): string {
  const upstream = [`ClickUp task: ${task.id}`, ...(task.url ? [`URL: ${task.url}`] : [])].join("\n");
  const commentBlock = triggerComment
    ? `\n\n## ClickUp trigger comment ${triggerComment.id}\n\n${triggerComment.text}`
    : "";
  return `${body || "Imported from ClickUp."}${commentBlock}\n\n## Upstream\n\n${upstream}`;
}

/**
 * Detect ClickUp attachments on a source task and persist them locally.
 * Idempotent across syncs: each attachment is keyed `clickup:<taskId>:<attId>`,
 * so repeats resolve to the existing record without re-downloading. Downloads are
 * best-effort; an unreachable, oversize, or unreadable file is skipped rather
 * than failing the whole sync. Never throws.
 *
 * The operator token is attached only when the download URL is the verified
 * ClickUp API origin; signed/public attachment links are fetched without it so
 * the token cannot leak to a non-API host.
 */
async function importClickUpAttachments(
  root: string,
  options: { token: string; fetchImpl?: FetchLike },
  clickUpTaskId: string
): Promise<HarnessAttachment[]> {
  let remote: ClickUpAttachment[];
  try {
    remote = await listClickUpTaskAttachments({
      token: options.token,
      taskId: clickUpTaskId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
  } catch {
    return [];
  }

  const imported: HarnessAttachment[] = [];
  for (const attachment of remote) {
    if (!attachment.url) continue;
    const sourceKey = `clickup:${clickUpTaskId}:${attachment.id}`;
    const existing = await findAttachmentBySourceKey(root, sourceKey);
    if (existing) {
      imported.push(existing);
      continue;
    }
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      // Forward the token only to the verified ClickUp API origin; attachment
      // URLs are usually signed/public links on other hosts.
      const response = await fetchImpl(
        attachment.url,
        isClickUpApiUrl(attachment.url) ? { headers: { Authorization: options.token } } : undefined
      );
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      const filename =
        attachment.title ||
        (attachment.extension ? `${attachment.id}.${attachment.extension}` : attachment.id);
      imported.push(
        await saveRemoteAttachment(root, {
          filename,
          bytes,
          sourceUrl: attachment.url,
          sourceKey,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {})
        })
      );
    } catch {
      // Oversize, unreachable, or unreadable: skip this attachment, keep syncing.
    }
  }
  return imported;
}

/** Import attachments for an already-managed task and append any not yet stored on
 * it. Dedup is two-layer: `importClickUpAttachments` skips re-downloading known
 * source keys, and this append skips ids already present on the task. A mapping
 * whose local task has been deleted is skipped (not downloaded into, not updated)
 * so one stale mapping cannot fail the whole sync. */
async function syncTaskAttachments(
  root: string,
  options: { token: string; fetchImpl?: FetchLike },
  clickUpTaskId: string,
  harnessTaskId: string
): Promise<void> {
  const task = await getTask(root, harnessTaskId);
  if (!task) return;
  const imported = await importClickUpAttachments(root, options, clickUpTaskId);
  if (imported.length === 0) return;
  const present = new Set((task.attachments ?? []).map((attachment) => attachment.id));
  const fresh = imported.filter((attachment) => !present.has(attachment.id));
  if (fresh.length === 0) return;
  await updateTask(root, harnessTaskId, (current) => ({
    ...current,
    attachments: [...(current.attachments ?? []), ...fresh],
    updatedAt: new Date().toISOString()
  }));
}

async function importNewTriggeredComments(
  root: string,
  synced: ClickUpSyncedTask,
  comments: ClickUpTaskComment[],
  integrationUserId?: string
): Promise<number> {
  let imported = 0;
  let cursor = synced.lastProcessedCommentAt ?? "0";
  for (const comment of comments) {
    if (Number(comment.date) <= Number(cursor)) continue;
    if (
      !commentContainsHarnessTrigger(
        { text: comment.text, ...(comment.authorId ? { authorId: comment.authorId } : {}) },
        integrationUserId
      )
    ) continue;
    await addTaskMessage(root, synced.harnessTaskId, {
      author: "operator",
      body: `ClickUp comment ${comment.id}:\n\n${comment.text}`
    });
    imported += 1;
    cursor = comment.date;
  }
  if (cursor !== (synced.lastProcessedCommentAt ?? "0")) {
    await updateClickUpSyncState(root, updateSyncedTask(synced.clickUpTaskId, { lastProcessedCommentAt: cursor }));
  }
  return imported;
}

/**
 * A transient transport failure on a non-idempotent outbound comment POST must
 * not abort the whole sync. The POST is deliberately single-attempt (no retry,
 * so a read-timeout after ClickUp accepted it cannot duplicate the comment), so
 * defer it: leave the posted flag false and let the next polling interval retry.
 * Durable failures (auth, malformed request) are not transient and still throw.
 */
function deferTransientCommentPost(error: unknown, clickUpTaskId: string, kind: "pickup" | "completion"): void {
  if (!isTransientNetworkError(error)) throw error;
  console.warn(
    `harness:clickup-sync task ${clickUpTaskId} ${kind} comment post failed transiently ` +
      `(${describeNetworkError(error)}); deferring to next interval.`,
    error
  );
}

async function pushOutbound(
  root: string,
  token: string,
  clickUpTaskId: string,
  synced: ClickUpSyncedTask,
  fetchImpl?: FetchLike
): Promise<number> {
  const task = await getTask(root, synced.harnessTaskId);
  if (!task) return 0;

  const current = normalizeSyncedTask(synced);
  const pmStatus = await outboundPmStatus(root, task);
  const patch: Partial<ClickUpSyncedTask> = {};
  let wrote = false;
  let stateChanged = false;

  const clickUpStatus = statusToClickUp(pmStatus);
  if (
    clickUpStatus &&
    clickUpStatus !== current.lastPostedStatus &&
    clickUpStatus !== current.lastRejectedStatus
  ) {
    try {
      await updateClickUpTaskStatus({
        token,
        taskId: clickUpTaskId,
        status: clickUpStatus,
        ...(fetchImpl ? { fetchImpl } : {})
      });
      patch.lastPostedStatus = clickUpStatus;
      wrote = true;
      stateChanged = true;
    } catch (error) {
      if (!(error instanceof ClickUpApiError) || error.status !== 400) throw error;
      patch.lastRejectedStatus = clickUpStatus;
      stateChanged = true;
    }
  }

  if (!current.pickedUpCommentPosted && task.startedAt) {
    try {
      await createClickUpComment({
        token,
        taskId: clickUpTaskId,
        text: "Mission Control picked up this ticket.",
        ...(fetchImpl ? { fetchImpl } : {})
      });
      patch.pickedUpCommentPosted = true;
      wrote = true;
      stateChanged = true;
    } catch (error) {
      deferTransientCommentPost(error, clickUpTaskId, "pickup");
    }
  }

  if (!current.completedCommentPosted && task.resolution === "completed") {
    try {
      await createClickUpComment({
        token,
        taskId: clickUpTaskId,
        text: completionComment(task),
        ...(fetchImpl ? { fetchImpl } : {})
      });
      patch.completedCommentPosted = true;
      wrote = true;
      stateChanged = true;
    } catch (error) {
      deferTransientCommentPost(error, clickUpTaskId, "completion");
    }
  }

  if (stateChanged || synced.lastOutboundFingerprint) {
    await updateClickUpSyncState(root, (state) => {
      const existing = state.tasks[clickUpTaskId];
      if (!existing) return state;
      const { lastOutboundFingerprint: _legacy, ...rest } = existing;
      const merged: ClickUpSyncedTask = { ...rest, ...patch };
      if (patch.lastPostedStatus !== undefined) {
        delete merged.lastRejectedStatus;
      }
      if (synced.lastOutboundFingerprint && merged.pickedUpCommentPosted === undefined) {
        merged.pickedUpCommentPosted = true;
      }
      return { ...state, tasks: { ...state.tasks, [clickUpTaskId]: merged } };
    });
  }
  return wrote ? 1 : 0;
}

/**
 * Drops the legacy fingerprint marker, seeding the pickup flag from it exactly once so tickets
 * already announced before this change are not re-announced with the new wording.
 */
function normalizeSyncedTask(synced: ClickUpSyncedTask): ClickUpSyncedTask {
  const { lastOutboundFingerprint, ...rest } = synced;
  return { ...rest, pickedUpCommentPosted: rest.pickedUpCommentPosted ?? Boolean(lastOutboundFingerprint) };
}

function completionComment(task: HarnessTask): string {
  const base = "Mission Control completed this ticket.";
  const mergeRequest = task.mergeRequest;
  if (!mergeRequest?.url) return base;
  const label = mergeRequest.provider === "github" ? "PR" : "MR";
  return `${base}\n${label}: ${mergeRequest.url}`;
}

async function outboundPmStatus(root: string, task: HarnessTask): Promise<PmStatus> {
  const workflow = await loadWorkflow(root, task.workflowRun?.workflowId ?? "code-feature");
  return effectivePmStatus(task, workflow);
}

function statusToClickUp(status: PmStatus): string | undefined {
  if (status === "in_progress") return "in progress";
  if (status === "in_review") return "in review";
  if (status === "done") return "done";
  return undefined;
}

function updateSyncedTask(
  clickUpTaskId: string,
  patch: Partial<ClickUpSyncedTask>
): (state: ClickUpSyncState) => ClickUpSyncState {
  return (state) => ({
    ...state,
    tasks: {
      ...state.tasks,
      [clickUpTaskId]: {
        ...state.tasks[clickUpTaskId]!,
        ...patch
      }
    }
  });
}

function completed(summary: string, stats: SyncStats): AutonomyRunResult {
  const deferred =
    stats.commentFetchFailures > 0
      ? ` ${stats.commentFetchFailures} task comment fetch(es) failed transiently; deferred to next interval.`
      : "";
  return { jobId: "clickup-ticket-sync", status: "completed", summary: `${summary}${deferred}`, proposalsCreated: 0 };
}

function blocked(summary: string): AutonomyRunResult {
  return { jobId: "clickup-ticket-sync", status: "blocked", summary, proposalsCreated: 0 };
}
