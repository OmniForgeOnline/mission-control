import type { ConnectorVault } from "../../connectors/vault/types.ts";
import { hostToProviderId, resolveMergeRequestAuth, resolveRemoteRepo } from "./resolve.ts";
import type { MergeRequestProviderId } from "./types.ts";

export interface MergeRequestLink {
  provider: MergeRequestProviderId;
  url: string;
  number: number;
}

type FetchLike = typeof fetch;

export type MergeRequestState = "open" | "merged" | "closed";

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
  provider: MergeRequestProviderId;
  number: number;
  fetchImpl?: FetchLike;
  vault?: ConnectorVault;
}): Promise<MergeRequestState | null> {
  const repo = await resolveRemoteRepo(options.repoPath);
  if (!repo) return null;

  const providerId = hostToProviderId(repo.host);
  if (providerId !== options.provider) return null;

  const token = await resolveMergeRequestAuth(options.root, providerId, {
    ...(options.vault !== undefined ? { vault: options.vault } : {})
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  if (providerId === "github") {
    const [owner, name] = repo.slug.split("/");
    if (!owner || !name) return null;
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${name}/pulls/${options.number}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) return null;
    const pull = (await response.json()) as GithubPullStatus;
    if (pull.merged) return "merged";
    return pull.state === "open" ? "open" : "closed";
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
  if (!response.ok) return null;
  const mr = (await response.json()) as GitlabMergeRequestStatus;
  if (mr.state === "merged") return "merged";
  if (mr.state === "opened") return "open";
  return "closed";
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