import type { RepoHost } from "../../connectors/repo-bind.ts";

export type MergeRequestProviderId = "github" | "gitlab";

export interface RemoteRepoIdentity {
  host: RepoHost;
  slug: string;
}

export interface MergeRequestInput {
  repo: RemoteRepoIdentity;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface MergeRequestResult {
  url: string;
  number: number;
  provider: MergeRequestProviderId;
  /** False when returning an existing open MR/PR for the branch. */
  created: boolean;
}

export interface MergeRequestReadyInput {
  repo: RemoteRepoIdentity;
  number: number;
}

export interface MergeRequestProvider {
  id: MergeRequestProviderId;
  createMergeRequest(input: MergeRequestInput, token: string): Promise<MergeRequestResult>;
  /**
   * Remove the draft flag from an already-open MR/PR. Called only at the final
   * handoff after review acceptance, never at creation time. No-op when the
   * MR/PR is already ready so the call is idempotent.
   */
  markReady(input: MergeRequestReadyInput, token: string): Promise<void>;
}