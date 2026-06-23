import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: ExecFileOptions
) => Promise<{ stdout: string; stderr: string }>;

let execFileImpl: ExecFileFn = execFileAsync;

export function setGhExecImpl(impl: ExecFileFn): void {
  execFileImpl = impl;
}

export function resetGhExecImpl(): void {
  execFileImpl = execFileAsync;
}

export async function isGhAuthenticated(): Promise<boolean> {
  try {
    const { stdout } = await execFileImpl("gh", ["auth", "status"]);
    return /logged in to/i.test(stdout);
  } catch {
    return false;
  }
}

export async function getGhToken(): Promise<string> {
  const { stdout } = await execFileImpl("gh", ["auth", "token"]);
  const token = stdout.trim();
  if (!token) {
    throw new Error("GitHub CLI returned an empty token. Run `gh auth login` first.");
  }
  return token;
}