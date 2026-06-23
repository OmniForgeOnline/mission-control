import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

const GIT_ENV_KEYS = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"] as const;

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS) delete env[key];
  return env;
}

/** Best-effort git invocation; returns trimmed stdout or an empty string on failure. */
export async function safeGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv(), maxBuffer: DEFAULT_MAX_BUFFER });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Best-effort subprocess invocation; returns raw stdout or an empty string on failure. */
export async function safeExec(cwd: string, cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER });
    return stdout;
  } catch {
    return "";
  }
}

export async function gitCommitSubjects(cwd: string, baseBranch: string, limit = 20): Promise<string[]> {
  let commitLog = await safeGit(cwd, ["log", `${baseBranch}..HEAD`, "--format=%s", "-n", String(limit)]);
  if (!commitLog) {
    commitLog = await safeGit(cwd, ["log", "-n", String(limit), "--format=%s"]);
  }
  return commitLog ? commitLog.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

export async function gitDiffStat(cwd: string, baseBranch: string, maxLength?: number): Promise<string> {
  const diffStat = await safeGit(cwd, ["diff", "--stat", `${baseBranch}...HEAD`]);
  return maxLength ? diffStat.slice(0, maxLength) : diffStat;
}

export async function gitChangedFiles(cwd: string, baseBranch: string, maxFiles?: number): Promise<string[]> {
  const changedFiles = await safeGit(cwd, ["diff", "--name-only", `${baseBranch}...HEAD`]);
  const files = changedFiles
    ? changedFiles.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  return maxFiles ? files.slice(0, maxFiles) : files;
}