import { execFile, spawn } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { safeExec, safeGit } from "../infra/git.ts";
import { ensureDir } from "../infra/fs.ts";
import type { HarnessTask } from "../types.ts";
import { stepUsesRepoWorkspace, type WorkflowStep } from "../workflows/index.ts";

const execFileAsync = promisify(execFile);
const prepareLocks = new Map<string, Promise<void>>();

export interface PreparedWorkspace {
  /** Working directory the agent will run in. */
  cwd: string;
  /** Absolute path of the destination repo, when the task targets one. */
  repoPath?: string;
  /** Branch name created or reused for this task. Only set when repoPath is set. */
  branch?: string;
  /** True when prepareWorkspace had to create the worktree on this call. */
  created: boolean;
  /** True when the destination is a git repo (so push-flow applies). */
  isRepo: boolean;
}

export interface PrepareWorkspaceOptions {
  /** Absolute harness root used for fallback scratch dirs. */
  harnessRoot: string;
}

function shortId(taskId: string): string {
  return taskId.replace(/-/g, "").slice(0, 12);
}

function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function branchNameFor(task: HarnessTask): string {
  const id = shortId(task.id);
  const slug = branchSlug(task.title);
  return `harness/${slug ? `${slug}-${id}` : id}`;
}

export function worktreePathFor(harnessRoot: string, task: HarnessTask): string {
  return path.join(harnessRoot, "data", "state", "worktrees", shortId(task.id));
}

async function pickTargetDir(task: HarnessTask): Promise<string | undefined> {
  const first = task.targets[0];
  if (!first) return undefined;
  return first.kind === "directory" ? first.path : path.dirname(first.path);
}

async function gitTopLevel(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Base branch for comparing a task branch against mainline (prefers main/master). */
export async function resolveComparisonBaseBranch(repoPath: string): Promise<string> {
  for (const candidate of ["main", "master"]) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", candidate], { cwd: repoPath });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return defaultBaseBranch(repoPath);
}

export async function defaultBaseBranch(repoPath: string): Promise<string> {
  // Prefer origin/HEAD when set, then local main/master, before falling back to HEAD.
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: repoPath });
    const ref = stdout.trim();
    if (ref) return ref.replace(/^origin\//, "");
  } catch {
    /* fall through */
  }
  for (const candidate of ["main", "master"]) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", candidate], { cwd: repoPath });
      return candidate;
    } catch {
      /* try next */
    }
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    const ref = stdout.trim();
    if (ref) return ref;
  } catch {
    /* fall through */
  }
  return "main";
}

/** Best-effort fetch so worktrees branch from the latest remote main. */
async function fetchOrigin(repoPath: string): Promise<void> {
  try {
    await execFileAsync("git", ["fetch", "origin"], { cwd: repoPath });
  } catch {
    /* offline or no remote — fall back to local refs */
  }
}

/** Prefer origin/<base> after fetch; fall back to the local branch when offline. */
async function originBaseRef(repoPath: string, baseBranch?: string): Promise<string> {
  const branch = baseBranch ?? (await defaultBaseBranch(repoPath));
  const originRef = `origin/${branch}`;
  try {
    await execFileAsync("git", ["rev-parse", "--verify", originRef], { cwd: repoPath });
    return originRef;
  } catch {
    return branch;
  }
}

function isFreshTaskTurn(task: HarnessTask): boolean {
  return (task.turnCount ?? 0) === 0;
}

/**
 * Align a task worktree with the latest main before a fresh turn.
 * In-progress tasks (turnCount > 0) keep their branch tip so implement → checks → review stay consistent.
 */
async function refreshWorktreeFromMain(worktreeDir: string, repoPath: string): Promise<void> {
  await fetchOrigin(repoPath);
  const baseBranch = await defaultBaseBranch(repoPath);
  const baseRef = await originBaseRef(repoPath, baseBranch);
  await execFileAsync("git", ["reset", "--hard", baseRef], { cwd: worktreeDir });
}

async function resolveComparablePath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function worktreeExists(repoPath: string, worktreeDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
    const target = await resolveComparablePath(worktreeDir);
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const listed = await resolveComparablePath(line.slice(9));
      if (listed === target) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Keep an in-progress task worktree on its harness branch (implement → checks → review). */
async function ensureTaskBranchCheckedOut(worktreeDir: string, branch: string): Promise<void> {
  const current = (await safeGit(worktreeDir, ["branch", "--show-current"])).trim();
  if (current === branch) return;
  try {
    await execFileAsync("git", ["checkout", branch], { cwd: worktreeDir });
  } catch {
    await execFileAsync("git", ["switch", branch], { cwd: worktreeDir });
  }
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent: prepare an isolated workspace for a task turn.
 *
 * - Destination is a git repo → one worktree per task on `harness/<id>`, branched from
 *   `origin/<base>` after fetch. Fresh turns reset reused worktrees to the latest main;
 *   in-progress turns keep their branch tip across implement → checks → review.
 * - Destination is a non-repo dir → return the dir as-is, no git interaction.
 * - No destination at all → return a per-task scratch dir under state/scratch/.
 */
async function prepareScratchWorkspace(task: HarnessTask, harnessRoot: string): Promise<PreparedWorkspace> {
  const scratch = path.join(harnessRoot, "data", "state", "scratch", shortId(task.id));
  await ensureDir(scratch);
  return { cwd: scratch, isRepo: false, created: false };
}

async function withPrepareLock<T>(worktreeDir: string, prepare: () => Promise<T>): Promise<T> {
  const previous = prepareLocks.get(worktreeDir);
  if (previous) {
    await previous.catch(() => {});
  }

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  prepareLocks.set(worktreeDir, current);

  try {
    return await prepare();
  } finally {
    release();
    if (prepareLocks.get(worktreeDir) === current) {
      prepareLocks.delete(worktreeDir);
    }
  }
}

/**
 * Prepare an isolated git worktree on `harness/<id>` when the task targets a repo.
 */
export async function prepareWorkspace(
  task: HarnessTask,
  options: PrepareWorkspaceOptions
): Promise<PreparedWorkspace> {
  const targetDir = await pickTargetDir(task);
  if (!targetDir) {
    return prepareScratchWorkspace(task, options.harnessRoot);
  }

  const repoPath = await gitTopLevel(targetDir);
  if (!repoPath) {
    await ensureDir(targetDir);
    return { cwd: targetDir, isRepo: false, created: false };
  }

  const worktreeDir = worktreePathFor(options.harnessRoot, task);
  const branch = branchNameFor(task);
  return withPrepareLock(worktreeDir, async () => {
    const alreadyExists = await worktreeExists(repoPath, worktreeDir);
    if (alreadyExists) {
      if (isFreshTaskTurn(task)) {
        await refreshWorktreeFromMain(worktreeDir, repoPath);
      } else {
        await fetchOrigin(repoPath);
        await ensureTaskBranchCheckedOut(worktreeDir, branch);
      }
      return { cwd: worktreeDir, repoPath, branch, isRepo: true, created: false };
    }

    await rm(worktreeDir, { recursive: true, force: true });
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await fetchOrigin(repoPath);
    const baseBranch = await defaultBaseBranch(repoPath);
    const baseRef = await originBaseRef(repoPath, baseBranch);

    if (await branchExists(repoPath, branch)) {
      if (isFreshTaskTurn(task)) {
        await execFileAsync("git", ["branch", "-f", branch, baseRef], { cwd: repoPath });
      }
      await execFileAsync("git", ["worktree", "add", worktreeDir, branch], { cwd: repoPath });
    } else {
      await execFileAsync("git", ["worktree", "add", "-b", branch, worktreeDir, baseRef], { cwd: repoPath });
    }

    return { cwd: worktreeDir, repoPath, branch, isRepo: true, created: true };
  });
}

/**
 * Pick a workspace for a workflow step. Planning/conversation steps use scratch;
 * repo-changing steps get an isolated worktree + branch so parallel tasks do not clash.
 */
export async function prepareStepWorkspace(
  task: HarnessTask,
  step: WorkflowStep,
  options: PrepareWorkspaceOptions
): Promise<PreparedWorkspace> {
  if (!stepUsesRepoWorkspace(step, task)) {
    return prepareScratchWorkspace(task, options.harnessRoot);
  }

  const targetDir = await pickTargetDir(task);
  if (!targetDir) {
    return prepareScratchWorkspace(task, options.harnessRoot);
  }

  const repoPath = await gitTopLevel(targetDir);
  if (!repoPath) {
    await ensureDir(targetDir);
    return { cwd: targetDir, isRepo: false, created: false };
  }

  return prepareWorkspace(task, options);
}

/**
 * Best-effort cleanup. Idempotent and safe to call multiple times.
 */
export async function cleanupWorkspace(
  task: HarnessTask,
  options: PrepareWorkspaceOptions
): Promise<void> {
  const targetDir = (await pickTargetDir(task)) ?? task.repoPath;
  if (!targetDir) {
    const scratch = path.join(options.harnessRoot, "data", "state", "scratch", shortId(task.id));
    await rm(scratch, { recursive: true, force: true });
    return;
  }
  const repoPath = task.repoPath ?? (await gitTopLevel(targetDir));
  if (!repoPath) return;
  const worktreeDir = worktreePathFor(options.harnessRoot, task);
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoPath });
  } catch {
    /* ignore — worktree may already be gone */
  }
  await rm(worktreeDir, { recursive: true, force: true });
}

export interface PostTurnGitState {
  /** Number of commits ahead of the remote tracking branch (or HEAD if no remote). */
  commitCount: number;
  /** True when the local branch has commits the remote does not. */
  hasUnpushedCommits: boolean;
  /** True when tracked or untracked worktree changes remain. */
  hasUncommittedChanges: boolean;
  /** Raw `git status --porcelain` output for diagnostics. */
  status: string;
  /** Current HEAD sha or undefined when not in a repo. */
  headSha?: string;
  /** Diff against the base branch (truncated to maxDiffBytes). */
  diff: string;
  /** Branch name. */
  branch?: string;
  /** True when the agent pushed during this turn (remote points at headSha). */
  pushed: boolean;
}

const MAX_DIFF_BYTES = 64 * 1024;

/**
 * After a turn completes, inspect the worktree to figure out whether the agent
 * actually committed and pushed. Used by the processor to decide the next status.
 */
export async function inspectPostTurnGit(prepared: PreparedWorkspace): Promise<PostTurnGitState | null> {
  if (!prepared.isRepo) return null;
  const cwd = prepared.cwd;
  const branch = prepared.branch;

  const headSha = (await safeGit(cwd, ["rev-parse", "HEAD"])).trim() || undefined;
  const status = (await safeGit(cwd, ["status", "--porcelain"])).trim();
  const remoteSha = branch
    ? (await safeGit(cwd, ["rev-parse", `origin/${branch}`])).trim() || undefined
    : undefined;
  const baseBranch = prepared.repoPath ? await resolveComparisonBaseBranch(prepared.repoPath) : "main";

  const aheadOfBase = parseInt(
    (await safeGit(cwd, ["rev-list", "--count", `${baseBranch}..HEAD`])).trim() || "0",
    10
  ) || 0;

  const aheadOfRemote = remoteSha
    ? parseInt((await safeGit(cwd, ["rev-list", "--count", `${remoteSha}..HEAD`])).trim() || "0", 10) || 0
    : aheadOfBase;

  const diffRaw = await safeExec(cwd, "git", ["diff", "--no-color", `${baseBranch}...HEAD`]);
  const diff = diffRaw.length > MAX_DIFF_BYTES ? `${diffRaw.slice(0, MAX_DIFF_BYTES)}\n[diff truncated]` : diffRaw;

  return {
    commitCount: aheadOfBase,
    hasUnpushedCommits: aheadOfRemote > 0,
    hasUncommittedChanges: status.length > 0,
    status,
    ...(headSha !== undefined ? { headSha } : {}),
    diff,
    ...(branch !== undefined ? { branch } : {}),
    pushed: !!remoteSha && aheadOfRemote === 0 && aheadOfBase > 0
  };
}

/** Run a child process and capture combined stdout/stderr. Used by checks. */
export function runShell(
  command: string,
  args: string[],
  cwd: string,
  onChunk?: (chunk: string) => void
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      onChunk?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
      onChunk?.(chunk);
    });
    child.on("error", (err) => resolve({ exitCode: 1, output: `${output}\n${err.message}` }));
    child.on("close", (code) => resolve({ exitCode: typeof code === "number" ? code : 1, output }));
  });
}
