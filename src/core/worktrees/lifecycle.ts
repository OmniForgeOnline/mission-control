import { execFile } from "node:child_process";
import { access, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { findMergeRequestByBranch, getMergeRequestState } from "../merge-request/status.ts";
import type { HarnessTask } from "../types.ts";
import { updateTask } from "../tasks/tasks.ts";
import { cleanupWorkspace, worktreePathFor } from "./worktrees.ts";

const execFileAsync = promisify(execFile);

const TERMINAL_WORKTREE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface WorktreeCleanupResult {
  taskId: string;
  cleaned: boolean;
  reason: string;
}

function taskShortId(taskId: string): string {
  return taskId.replace(/-/g, "").slice(0, 12);
}

function repoBackedTask(task: HarnessTask): boolean {
  return Boolean(task.repoPath && task.branch);
}

function isTerminalTask(task: HarnessTask): boolean {
  return task.resolution === "completed" || task.resolution === "cancelled";
}

function isPastGracePeriod(isoTimestamp: string, graceMs: number): boolean {
  return Date.now() - new Date(isoTimestamp).getTime() >= graceMs;
}

function terminalTaskReadyForCleanup(task: HarnessTask): boolean {
  const anchor = task.completedAt ?? task.updatedAt;
  return isPastGracePeriod(anchor, TERMINAL_WORKTREE_GRACE_MS);
}

async function worktreeDirExists(worktreeDir: string): Promise<boolean> {
  try {
    await access(worktreeDir);
    return true;
  } catch {
    return false;
  }
}

async function resolveMainRepoFromWorktree(worktreeDir: string): Promise<string | undefined> {
  try {
    const content = await readFile(path.join(worktreeDir, ".git"), "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) return undefined;
    const gitdirMatch = match[1];
    if (!gitdirMatch) return undefined;
    const gitdir = gitdirMatch.trim();
    if (gitdir.includes("/worktrees/")) {
      return path.resolve(gitdir, "../../..");
    }
    return path.resolve(gitdir, "..");
  } catch {
    return undefined;
  }
}

async function removeWorktreeAt(worktreeDir: string): Promise<void> {
  const repoPath = await resolveMainRepoFromWorktree(worktreeDir);
  if (repoPath) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoPath });
    } catch {
      /* worktree may already be gone from git's perspective */
    }
  }
  await rm(worktreeDir, { recursive: true, force: true });
}

/**
 * Remove the isolated git worktree for a task after its merge request has landed.
 * Idempotent: no-ops when the worktree is already gone or the task was cleaned up.
 */
async function cleanupTaskWorktreeAfterMerge(
  root: string,
  task: HarnessTask
): Promise<WorktreeCleanupResult> {
  if (task.worktreeCleanedAt) {
    return { taskId: task.id, cleaned: false, reason: "already cleaned" };
  }
  if (!repoBackedTask(task)) {
    return { taskId: task.id, cleaned: false, reason: "not repo-backed" };
  }

  const worktreeDir = worktreePathFor(root, task);
  const exists = await worktreeDirExists(worktreeDir);
  if (!exists) {
    await updateTask(root, task.id, (current) => {
      const { workspacePath: _workspace, ...rest } = current;
      return {
        ...rest,
        worktreeCleanedAt: current.worktreeCleanedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
    return { taskId: task.id, cleaned: false, reason: "worktree already absent" };
  }

  await cleanupWorkspace(task, { harnessRoot: root });
  const timestamp = new Date().toISOString();
  await updateTask(root, task.id, (current) => {
    const { workspacePath: _workspace, ...rest } = current;
    const mergeRequest = current.mergeRequest
      ? { ...current.mergeRequest, mergedAt: current.mergeRequest.mergedAt ?? timestamp }
      : undefined;
    return {
      ...rest,
      worktreeCleanedAt: timestamp,
      ...(mergeRequest !== undefined ? { mergeRequest } : {}),
      updatedAt: timestamp
    };
  });

  return { taskId: task.id, cleaned: true, reason: "worktree removed after merge" };
}

async function cleanupTerminalTaskWorktree(
  root: string,
  task: HarnessTask
): Promise<WorktreeCleanupResult> {
  const worktreeDir = worktreePathFor(root, task);
  if (!(await worktreeDirExists(worktreeDir))) {
    return { taskId: task.id, cleaned: false, reason: "worktree already absent" };
  }

  if (repoBackedTask(task)) {
    const result = await cleanupTaskWorktreeAfterMerge(root, task);
    return result.cleaned
      ? { ...result, reason: "terminal task worktree removed" }
      : result;
  }

  await removeWorktreeAt(worktreeDir);
  const timestamp = new Date().toISOString();
  await updateTask(root, task.id, (current) => {
    const { workspacePath: _workspace, ...rest } = current;
    return { ...rest, worktreeCleanedAt: timestamp, updatedAt: timestamp };
  });
  return { taskId: task.id, cleaned: true, reason: "terminal task worktree removed" };
}

async function backfillMergeRequest(
  root: string,
  task: HarnessTask
): Promise<HarnessTask> {
  if (task.mergeRequest || !task.repoPath || !task.branch || !task.pushedAt) {
    return task;
  }

  const found = await findMergeRequestByBranch({
    root,
    repoPath: task.repoPath,
    branch: task.branch
  });
  if (!found) return task;

  await updateTask(root, task.id, (current) => ({
    ...current,
    mergeRequest: found,
    updatedAt: new Date().toISOString()
  }));
  return { ...task, mergeRequest: found };
}

async function cleanupOrphanWorktrees(
  root: string,
  tasks: HarnessTask[]
): Promise<WorktreeCleanupResult[]> {
  const worktreesRoot = path.join(root, "data", "state", "worktrees");
  let entries: string[];
  try {
    entries = await readdir(worktreesRoot);
  } catch {
    return [];
  }

  const results: WorktreeCleanupResult[] = [];

  for (const entry of entries) {
    const matchingTask = tasks.find((task) => taskShortId(task.id) === entry);
    if (matchingTask) continue;

    const worktreeDir = path.join(worktreesRoot, entry);
    if (!(await worktreeDirExists(worktreeDir))) continue;

    await removeWorktreeAt(worktreeDir);
    results.push({
      taskId: entry,
      cleaned: true,
      reason: "orphan worktree removed"
    });
  }

  return results;
}

/**
 * Scan repo-backed tasks and on-disk worktrees, then clean up once merged or terminal.
 */
export async function cleanupMergedTaskWorktrees(
  root: string,
  tasks: HarnessTask[]
): Promise<WorktreeCleanupResult[]> {
  const results: WorktreeCleanupResult[] = [];

  for (const task of tasks) {
    if (task.worktreeCleanedAt) continue;

    const worktreeDir = worktreePathFor(root, task);
    if (!(await worktreeDirExists(worktreeDir))) continue;

    if (isTerminalTask(task) && terminalTaskReadyForCleanup(task)) {
      results.push(await cleanupTerminalTaskWorktree(root, task));
      continue;
    }

    if (!repoBackedTask(task)) {
      results.push({ taskId: task.id, cleaned: false, reason: "not repo-backed" });
      continue;
    }

    const taskWithMr = await backfillMergeRequest(root, task);
    if (!taskWithMr.mergeRequest) {
      results.push({ taskId: task.id, cleaned: false, reason: "no merge request" });
      continue;
    }

    let result: Awaited<ReturnType<typeof getMergeRequestState>>;
    try {
      result = await getMergeRequestState({
        root,
        repoPath: taskWithMr.repoPath!,
        ...(taskWithMr.mergeRequest.url ? { url: taskWithMr.mergeRequest.url } : {}),
        provider: taskWithMr.mergeRequest.provider,
        number: taskWithMr.mergeRequest.number
      });
    } catch {
      results.push({ taskId: task.id, cleaned: false, reason: "merge status lookup failed" });
      continue;
    }

    if (result.state !== "merged") {
      results.push({
        taskId: task.id,
        cleaned: false,
        reason: result.state ? `merge request ${result.state}` : "merge status unknown"
      });
      continue;
    }

    results.push(await cleanupTaskWorktreeAfterMerge(root, taskWithMr));
  }

  results.push(...(await cleanupOrphanWorktrees(root, tasks)));
  return results;
}