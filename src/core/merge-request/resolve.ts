import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getProviderAccessToken } from "../../connectors/connections.ts";
import type { ConnectorVault } from "../../connectors/vault/types.ts";
import { parseRemoteRepoRef } from "../../connectors/repo-bind.ts";
import { createGithubMergeRequestProvider } from "./github.ts";
import { createGitlabMergeRequestProvider } from "./gitlab.ts";
import type { MergeRequestProvider, MergeRequestProviderId, RemoteRepoIdentity } from "./types.ts";

const execFileAsync = promisify(execFile);

type FetchLike = typeof fetch;

export async function readOriginRemote(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoDir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function hostToProviderId(host: RemoteRepoIdentity["host"]): MergeRequestProviderId {
  return host === "github.com" ? "github" : "gitlab";
}

export async function resolveRemoteRepo(repoPath: string): Promise<RemoteRepoIdentity | null> {
  const remote = await readOriginRemote(repoPath);
  if (!remote) return null;
  const ref = parseRemoteRepoRef(remote);
  if (!ref) return null;
  return { host: ref.host, slug: ref.slug };
}

export function createMergeRequestProvider(
  providerId: MergeRequestProviderId,
  fetchImpl: FetchLike = fetch
): MergeRequestProvider {
  if (providerId === "github") return createGithubMergeRequestProvider(fetchImpl);
  return createGitlabMergeRequestProvider(fetchImpl);
}

export async function resolveMergeRequestAuth(
  root: string,
  providerId: MergeRequestProviderId,
  options?: { vault?: ConnectorVault }
): Promise<string> {
  const token = await getProviderAccessToken(root, providerId, options);
  if (!token) {
    const label = providerId === "github" ? "GitHub" : "GitLab";
    throw new Error(
      `Connect ${label} in Settings → Connectors with a token that can create merge requests.`
    );
  }
  return token;
}