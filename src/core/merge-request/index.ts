import type { ConnectorVault } from "../../connectors/vault/types.ts";
import type { MergeRequestInput, MergeRequestProviderId, MergeRequestResult } from "./types.ts";
import {
  createMergeRequestProvider,
  hostToProviderId,
  resolveMergeRequestAuth,
  resolveRemoteRepo
} from "./resolve.ts";

type FetchLike = typeof fetch;

export type { MergeRequestResult } from "./types.ts";
export { hostToProviderId, readOriginRemote } from "./resolve.ts";
export { composeMergeRequestContent } from "./compose.ts";

export async function createMergeRequestForRepo(options: {
  root: string;
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  fetchImpl?: FetchLike;
  vault?: ConnectorVault;
}): Promise<MergeRequestResult> {
  const repo = await resolveRemoteRepo(options.repoPath);
  if (!repo) {
    throw new Error("Could not resolve git remote origin for merge request creation.");
  }

  const providerId = hostToProviderId(repo.host);
  const token = await resolveMergeRequestAuth(options.root, providerId, {
    ...(options.vault !== undefined ? { vault: options.vault } : {})
  });
  const provider = createMergeRequestProvider(providerId, options.fetchImpl);

  const input: MergeRequestInput = {
    repo,
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    title: options.title,
    description: options.description
  };

  return provider.createMergeRequest(input, token);
}

/**
 * Remove the draft flag from an already-open MR/PR. Called only at the final
 * handoff (after review acceptance); never at creation time. Throws on forge
 * API failure so the caller can surface it without blocking task completion.
 */
export async function markMergeRequestReadyForRepo(options: {
  root: string;
  repoPath: string;
  provider: MergeRequestProviderId;
  number: number;
  fetchImpl?: FetchLike;
  vault?: ConnectorVault;
}): Promise<void> {
  const repo = await resolveRemoteRepo(options.repoPath);
  if (!repo) {
    throw new Error("Could not resolve git remote origin for merge request readiness.");
  }

  const providerId = hostToProviderId(repo.host);
  if (providerId !== options.provider) {
    throw new Error(
      `Merge request provider ${options.provider} does not match resolved host ${repo.host}.`
    );
  }

  const token = await resolveMergeRequestAuth(options.root, providerId, {
    ...(options.vault !== undefined ? { vault: options.vault } : {})
  });
  const provider = createMergeRequestProvider(providerId, options.fetchImpl);

  return provider.markReady({ repo, number: options.number }, token);
}