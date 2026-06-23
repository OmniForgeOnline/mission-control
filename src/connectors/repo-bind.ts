import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { HarnessTarget } from "../core/types.ts";

const execFileAsync = promisify(execFile);

const MAX_DEPTH = 4;
const MAX_VISITED = 500;
const SKIPPED_DIRS = new Set([".cache", ".git", "Library", "node_modules"]);

export type RepoHost = "github.com" | "gitlab.com";

export interface RemoteRepoRef {
  host: RepoHost;
  slug: string;
}

export function parseRemoteRepoRef(remoteUrl: string): RemoteRepoRef | null {
  const trimmed = remoteUrl.trim().replace(/\/$/, "");
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    const host = normalizeHost(sshMatch[1]!);
    const slug = sshMatch[2]!.replace(/\.git$/i, "");
    if (!host || !slug) return null;
    return { host, slug };
  }

  try {
    const url = new URL(trimmed);
    const host = normalizeHost(url.hostname);
    const slug = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
    if (!host || !slug.includes("/")) return null;
    return { host, slug };
  } catch {
    return null;
  }
}

function normalizeHost(hostname: string): RepoHost | null {
  const lower = hostname.toLowerCase();
  if (lower === "github.com") return "github.com";
  if (lower === "gitlab.com") return "gitlab.com";
  return null;
}

function repoKey(ref: RemoteRepoRef): string {
  return `${ref.host}/${ref.slug}`;
}

async function readOriginRemote(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoDir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export async function indexLocalRepos(projectsRoot: string): Promise<Map<string, string>> {
  const root = path.resolve(projectsRoot);
  const index = new Map<string, string>();
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (visited >= MAX_VISITED || depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= MAX_VISITED) return;
      if (entry.startsWith(".") || SKIPPED_DIRS.has(entry)) continue;
      const fullPath = path.join(dir, entry);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      visited += 1;

      if (await isGitRepo(fullPath)) {
        const remote = await readOriginRemote(fullPath);
        const ref = remote ? parseRemoteRepoRef(remote) : null;
        if (ref) {
          index.set(repoKey(ref), fullPath);
        }
        continue;
      }

      await walk(fullPath, depth + 1);
    }
  }

  await walk(root, 0);
  return index;
}

function resolveBoundRepoPath(
  index: Map<string, string>,
  host: RepoHost,
  slug: string
): string | undefined {
  return index.get(`${host}/${slug}`);
}

function buildDirectoryTarget(repoPath: string): HarnessTarget {
  return {
    raw: `@${repoPath}`,
    path: repoPath,
    kind: "directory"
  };
}

export function bindIssueTask(input: {
  title: string;
  issueUrl: string;
  source: "github" | "gitlab";
  host: RepoHost;
  slug: string;
  projectsRoot: string;
  repoIndex: Map<string, string>;
}): { description: string; targets: HarnessTarget[] } {
  const localPath = resolveBoundRepoPath(input.repoIndex, input.host, input.slug);
  if (!localPath) {
    return {
      description: [
        `Imported from ${input.source === "github" ? "GitHub" : "GitLab"} issue ${input.issueUrl}`,
        "",
        `Remote: ${input.host}/${input.slug}`,
        `No local clone found under ${input.projectsRoot}. Add the repo there to auto-bind future imports.`
      ].join("\n"),
      targets: []
    };
  }

  const target = buildDirectoryTarget(localPath);
  return {
    description: [
      `Imported from ${input.source === "github" ? "GitHub" : "GitLab"} issue ${input.issueUrl}`,
      "",
      `Bound to local repo: ${localPath}`
    ].join("\n"),
    targets: [target]
  };
}