import type { RepoHost } from "../../connectors/repo-bind.ts";
import type { ConnectorVault } from "../../connectors/vault/types.ts";
import { hostToProviderId, resolveMergeRequestAuth, resolveRemoteRepo } from "./resolve.ts";
import type { MergeRequestProviderId, RemoteRepoIdentity } from "./types.ts";

export interface MergeRequestLink {
  provider: MergeRequestProviderId;
  url: string;
  number: number;
}

type FetchLike = typeof fetch;

export type MergeRequestState = "open" | "merged" | "closed";

/** Categorized reason the merge state could not be determined. */
export type MergeStateFailureReason =
  | "no_remote"
  | "host_mismatch"
  | "auth_missing"
  | "api_error"
  | "network_error";

export type MergeRequestStateResult =
  | { state: MergeRequestState }
  | { state: null; reason: MergeStateFailureReason; detail?: string };

/**
 * Derive the repo identity from a stored merge-request URL by taking the host
 * and the first two path segments (owner/repo). Works for GitHub
 * `.../pull/N` and GitLab `.../-/merge_requests/N`, which `parseRemoteRepoRef`
 * cannot consume because it treats the whole pathname as the slug.
 */
export function parseMergeRequestUrl(url: string): RemoteRepoIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "gitlab.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const rawRepo = segments[1];
  if (!owner || !rawRepo) return null;
  const slug = `${owner}/${rawRepo.replace(/\.git$/i, "")}`;
  return { host: hostname as RepoHost, slug };
}

/** Human-readable description of a merge-state failure for sweep summaries. */
export function describeMergeFailure(reason: MergeStateFailureReason, detail?: string): string {
  switch (reason) {
    case "no_remote":
      return detail ? `no git remote at ${detail}` : "no git remote";
    case "host_mismatch":
      return "provider/host mismatch";
    case "auth_missing":
      return detail ? `${detail} auth missing` : "forge auth missing";
    case "api_error":
      return detail ? `forge API error (${detail})` : "forge API error";
    case "network_error":
      return "network error contacting forge";
  }
}

interface GithubPullStatus {
  state: string;
  merged: boolean;
}

interface GitlabMergeRequestStatus {
  state: string;
}

export async function getMergeRequestState(options: {
  root: string;
  repoPath: string;
  url?: string;
  provider: MergeRequestProviderId;
  number: number;
  fetchImpl?: FetchLike;
  vault?: ConnectorVault;
}): Promise<MergeRequestStateResult> {
  // Prefer the stored merge-request URL for identity: it survives checkout
  // moves, worktrees, and runs on other machines. Fall back to the local remote
  // only when no URL is available.
  let repo: RemoteRepoIdentity | null = null;
  if (options.url) {
    repo = parseMergeRequestUrl(options.url);
  }
  if (!repo) {
    repo = await resolveRemoteRepo(options.repoPath);
  }
  if (!repo) {
    return { state: null, reason: "no_remote", detail: options.repoPath };
  }

  const providerId = hostToProviderId(repo.host);
  if (providerId !== options.provider) {
    return { state: null, reason: "host_mismatch" };
  }

  let token: string;
  try {
    token = await resolveMergeRequestAuth(options.root, providerId, {
      ...(options.vault !== undefined ? { vault: options.vault } : {})
    });
  } catch {
    return { state: null, reason: "auth_missing", detail: providerId === "github" ? "GitHub" : "GitLab" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    if (providerId === "github") {
      const [owner, name] = repo.slug.split("/");
      if (!owner || !name) {
        return { state: null, reason: "no_remote", detail: options.repoPath };
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${name}/pulls/${options.number}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json"
          }
        }
      );
      if (!response.ok) {
        return { state: null, reason: "api_error", detail: String(response.status) };
      }
      const pull = (await response.json()) as GithubPullStatus;
      if (pull.merged) return { state: "merged" };
      return { state: pull.state === "open" ? "open" : "closed" };
    }

    const projectId = encodeURIComponent(repo.slug);
    const response = await fetchImpl(
      `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${options.number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
    if (!response.ok) {
      return { state: null, reason: "api_error", detail: String(response.status) };
    }
    const mr = (await response.json()) as GitlabMergeRequestStatus;
    if (mr.state === "merged") return { state: "merged" };
    if (mr.state === "opened") return { state: "open" };
    return { state: "closed" };
  } catch {
    return { state: null, reason: "network_error" };
  }
}

interface GithubPullLink {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
}

interface GitlabMergeRequestLink {
  iid: number;
  web_url: string;
  state: string;
}

/**
 * Discover an open or merged PR/MR for a task branch when workflow metadata is missing.
 */
export async function findMergeRequestByBranch(options: {
  root: string;
  repoPath: string;
  branch: string;
  fetchImpl?: FetchLike;
  vault?: ConnectorVault;
}): Promise<MergeRequestLink | null> {
  const repo = await resolveRemoteRepo(options.repoPath);
  if (!repo) return null;

  const providerId = hostToProviderId(repo.host);
  const token = await resolveMergeRequestAuth(options.root, providerId, {
    ...(options.vault !== undefined ? { vault: options.vault } : {})
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  if (providerId === "github") {
    const [owner, name] = repo.slug.split("/");
    if (!owner || !name) return null;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json"
    };
    const head = `${owner}:${options.branch}`;
    const listUrl = `https://api.github.com/repos/${owner}/${name}/pulls?head=${encodeURIComponent(head)}&state=all`;
    const response = await fetchImpl(listUrl, { headers });
    if (!response.ok) return null;
    const pulls = (await response.json()) as GithubPullLink[];
    const match = pulls.find((pull) => pull.state === "open" || pull.merged) ?? pulls[0];
    if (!match) return null;
    return {
      provider: "github",
      url: match.html_url,
      number: match.number
    };
  }

  const projectId = encodeURIComponent(repo.slug);
  const headers = { Authorization: `Bearer ${token}` };
  const listUrl = `https://gitlab.com/api/v4/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(options.branch)}&state=all`;
  const response = await fetchImpl(listUrl, { headers });
  if (!response.ok) return null;
  const mergeRequests = (await response.json()) as GitlabMergeRequestLink[];
  const match =
    mergeRequests.find((mr) => mr.state === "opened" || mr.state === "merged") ?? mergeRequests[0];
  if (!match) return null;
  return {
    provider: "gitlab",
    url: match.web_url,
    number: match.iid
  };
}