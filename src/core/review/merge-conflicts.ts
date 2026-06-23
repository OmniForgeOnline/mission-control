import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { safeGit } from "../infra/git.ts";
import { defaultBaseBranch, runShell } from "../worktrees/worktrees.ts";

const execFileAsync = promisify(execFile);

/** Non-interactive git env so an automated fetch can never block on a credential prompt. */
const NON_INTERACTIVE_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  GCM_INTERACTIVE: "never"
} as NodeJS.ProcessEnv;

export type BaseMergeStatus = "up_to_date" | "merged_clean" | "conflicted";

export interface BaseMergeResult {
  /** Outcome of merging the latest base branch into the task branch. */
  status: BaseMergeStatus;
  /** Base branch name (e.g. "main"). */
  baseBranch: string;
  /** Ref actually merged (`origin/<base>` when available, else the local branch). */
  baseRef: string;
  /** Files left with conflict markers when status is "conflicted". */
  conflictedFiles: string[];
  /** Raw git output for diagnostics. */
  output: string;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const result = await runShell("git", ["rev-parse", "--verify", "--quiet", ref], cwd);
  return result.exitCode === 0;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runShell("git", ["merge-base", "--is-ancestor", ancestor, descendant], cwd);
  return result.exitCode === 0;
}

async function listUnmergedFiles(cwd: string): Promise<string[]> {
  const out = await safeGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return out ? out.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

/**
 * Resolve the ref to merge: prefer `origin/<base>` after a best-effort fetch so the
 * branch picks up the latest target; fall back to the local base branch when offline.
 */
async function resolveBaseRef(cwd: string, baseBranch: string): Promise<string> {
  try {
    await execFileAsync("git", ["fetch", "origin", baseBranch], { cwd, env: NON_INTERACTIVE_GIT_ENV });
  } catch {
    /* offline, no origin, or auth unavailable — fall back to the local base branch */
  }
  const originRef = `origin/${baseBranch}`;
  if (await refExists(cwd, originRef)) return originRef;
  return baseBranch;
}

/**
 * Merge the latest base branch into the current task branch inside `cwd`.
 *
 * - `up_to_date`: the branch already contains the base tip; nothing to do.
 * - `merged_clean`: the base advanced with non-overlapping changes; a merge commit
 *   was created and the branch should be pushed to keep the PR/MR mergeable.
 * - `conflicted`: true conflicts remain. The merge is left in progress (conflict
 *   markers in the worktree) so an agent can resolve, commit, and push.
 */
export async function attemptBaseMerge(
  cwd: string,
  repoPath: string,
  baseBranchOverride?: string
): Promise<BaseMergeResult> {
  const baseBranch = baseBranchOverride ?? (await defaultBaseBranch(repoPath));
  const baseRef = await resolveBaseRef(cwd, baseBranch);

  if (!(await refExists(cwd, baseRef))) {
    // No base ref to merge against (e.g. brand-new repo). Treat as nothing to do.
    return { status: "up_to_date", baseBranch, baseRef, conflictedFiles: [], output: "" };
  }

  if (await isAncestor(cwd, baseRef, "HEAD")) {
    return { status: "up_to_date", baseBranch, baseRef, conflictedFiles: [], output: "" };
  }

  const merge = await runShell("git", ["merge", "--no-edit", baseRef], cwd);
  if (merge.exitCode === 0) {
    return { status: "merged_clean", baseBranch, baseRef, conflictedFiles: [], output: merge.output };
  }

  const conflictedFiles = await listUnmergedFiles(cwd);
  return { status: "conflicted", baseBranch, baseRef, conflictedFiles, output: merge.output };
}

/** Abort an in-progress merge so the worktree is left clean (used when giving up). */
export async function abortMerge(cwd: string): Promise<void> {
  await runShell("git", ["merge", "--abort"], cwd);
}

/** Push the current branch tip to origin. Returns the push command result. */
export async function pushCurrentBranch(
  cwd: string,
  branch: string
): Promise<{ exitCode: number; output: string }> {
  return runShell("git", ["push", "origin", `HEAD:${branch}`], cwd);
}

export function describeBaseMergeOutcome(result: BaseMergeResult): string {
  switch (result.status) {
    case "up_to_date":
      return `Branch is already up to date with \`${result.baseBranch}\`; no merge conflicts.`;
    case "merged_clean":
      return `Merged latest \`${result.baseBranch}\` into the branch cleanly (no conflicts).`;
    case "conflicted":
      return `Merge conflicts with \`${result.baseBranch}\` in ${result.conflictedFiles.length} file(s): ${result.conflictedFiles
        .map((file) => `\`${file}\``)
        .join(", ")}.`;
  }
}

export function buildConflictRemediationPrompt(result: BaseMergeResult, round: number): string {
  const fileList = result.conflictedFiles.length
    ? result.conflictedFiles.map((file) => `- ${file}`).join("\n")
    : "- (run `git status` to list conflicted files)";
  return `A merge of the latest \`${result.baseBranch}\` into this branch produced conflicts (attempt ${round}). The merge is in progress in your worktree with conflict markers present.

Resolve the conflicts so the branch can merge cleanly into \`${result.baseBranch}\`:

${fileList}

Steps:
1. Open each conflicted file and reconcile the changes, removing all \`<<<<<<<\`, \`=======\`, and \`>>>>>>>\` markers.
2. Stage the resolved files with \`git add\`.
3. Complete the merge with \`git commit --no-edit\` (do not abort the merge).
4. Push the branch.

Keep both sides' intent intact; do not drop changes from \`${result.baseBranch}\`. When the push completes, end your turn — the harness will re-check mergeability.`;
}
