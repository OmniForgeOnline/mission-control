import { safeGit } from "../core/infra/git.ts";

/**
 * True when the worktree looks like a finished author handoff: on a harness
 * branch, clean tree, at least one commit ahead of main/master, and pushed.
 * Used to auto-complete interactive implement sessions without requiring Done.
 */
export async function isAuthorHandoffReady(cwd: string): Promise<boolean> {
  const branch = (await safeGit(cwd, ["branch", "--show-current"])).trim();
  if (!branch.startsWith("harness/")) return false;

  const status = (await safeGit(cwd, ["status", "--porcelain"])).trim();
  if (status.length > 0) return false;

  let base = "main";
  const hasMain = (await safeGit(cwd, ["rev-parse", "--verify", "main"])).trim();
  if (!hasMain) {
    const hasMaster = (await safeGit(cwd, ["rev-parse", "--verify", "master"])).trim();
    if (!hasMaster) return false;
    base = "master";
  }

  const aheadOfBase =
    parseInt((await safeGit(cwd, ["rev-list", "--count", `${base}..HEAD`])).trim() || "0", 10) || 0;
  if (aheadOfBase <= 0) return false;

  const remoteSha = (await safeGit(cwd, ["rev-parse", `origin/${branch}`])).trim();
  if (!remoteSha) return false;

  const unpushed =
    parseInt((await safeGit(cwd, ["rev-list", "--count", `origin/${branch}..HEAD`])).trim() || "0", 10) ||
    0;
  if (unpushed > 0) return false;

  return true;
}
