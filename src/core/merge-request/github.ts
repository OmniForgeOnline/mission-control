import type {
  MergeRequestInput,
  MergeRequestProvider,
  MergeRequestReadyInput,
  MergeRequestResult
} from "./types.ts";

type FetchLike = typeof fetch;

interface GithubPull {
  number: number;
  html_url: string;
}

interface GithubPullDetail {
  number: number;
  draft: boolean;
  node_id: string;
}

function validateGithubPull(pull: GithubPull, context: string): GithubPull {
  if (!Number.isInteger(pull.number) || typeof pull.html_url !== "string" || pull.html_url.trim() === "") {
    throw new Error(`GitHub pull request ${context} returned invalid metadata`);
  }
  return pull;
}

export function createGithubMergeRequestProvider(fetchImpl: FetchLike = fetch): MergeRequestProvider {
  return {
    id: "github",
    async createMergeRequest(input: MergeRequestInput, token: string): Promise<MergeRequestResult> {
      const [owner, repo] = input.repo.slug.split("/");
      if (!owner || !repo) {
        throw new Error(`Invalid GitHub repo slug: ${input.repo.slug}`);
      }

      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      };

      const head = `${owner}:${input.sourceBranch}`;
      const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(head)}&state=open`;
      const listResponse = await fetchImpl(listUrl, { headers });
      if (!listResponse.ok) {
        throw new Error(`GitHub pull request lookup failed (${listResponse.status})`);
      }
      const existing = (await listResponse.json()) as GithubPull[];
      if (existing.length > 0 && existing[0]) {
        const pull = validateGithubPull(existing[0], "lookup");
        return {
          url: pull.html_url,
          number: pull.number,
          provider: "github",
          created: false
        };
      }

      // Opened as draft: the harness marks the PR ready for review only at the
      // final handoff, after review accepts the work.
      const createResponse = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: input.title,
          body: input.description,
          head: input.sourceBranch,
          base: input.targetBranch,
          draft: true
        })
      });

      if (createResponse.status === 422) {
        const retry = await fetchImpl(listUrl, { headers });
        if (retry.ok) {
          const retryExisting = (await retry.json()) as GithubPull[];
          if (retryExisting.length > 0 && retryExisting[0]) {
            const pull = validateGithubPull(retryExisting[0], "lookup");
            return {
              url: pull.html_url,
              number: pull.number,
              provider: "github",
              created: false
            };
          }
        }
      }

      if (!createResponse.ok) {
        const detail = await createResponse.text().catch(() => "");
        throw new Error(`GitHub pull request creation failed (${createResponse.status})${detail ? `: ${detail}` : ""}`);
      }

      const created = (await createResponse.json()) as GithubPull;
      const pull = validateGithubPull(created, "creation");
      return {
        url: pull.html_url,
        number: pull.number,
        provider: "github",
        created: true
      };
    },

    async markReady(input: MergeRequestReadyInput, token: string): Promise<void> {
      const [owner, repo] = input.repo.slug.split("/");
      if (!owner || !repo) {
        throw new Error(`Invalid GitHub repo slug: ${input.repo.slug}`);
      }

      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      };

      // "Ready for review" has no REST endpoint; we need the PR's node id for the
      // GraphQL mutation, and we skip the mutation entirely when it is already ready.
      const detailResponse = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${input.number}`,
        { headers }
      );
      if (!detailResponse.ok) {
        throw new Error(`GitHub pull request lookup failed (${detailResponse.status})`);
      }
      const detail = (await detailResponse.json()) as GithubPullDetail;
      if (!detail.draft) return;

      const mutation = `
        mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            pullRequest { id }
          }
        }`;
      const graphqlResponse = await fetchImpl("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: mutation, variables: { pullRequestId: detail.node_id } })
      });
      if (!graphqlResponse.ok) {
        const errorDetail = await graphqlResponse.text().catch(() => "");
        throw new Error(
          `GitHub ready-for-review failed (${graphqlResponse.status})${errorDetail ? `: ${errorDetail}` : ""}`
        );
      }
    }
  };
}
