import type {
  MergeRequestInput,
  MergeRequestProvider,
  MergeRequestReadyInput,
  MergeRequestResult
} from "./types.ts";

type FetchLike = typeof fetch;

/**
 * GitLab exposes draft state only through the merge-request title: a title
 * starting with "Draft:" (or the legacy "WIP:") marks the MR as a draft. The
 * REST API has no boolean draft field, so we add/remove the prefix here.
 */
const GITLAB_DRAFT_PREFIX = "Draft: ";
const GITLAB_DRAFT_TITLE_PATTERN = /^(Draft|WIP|Wip):\s*/;

interface GitlabMergeRequest {
  iid: number;
  web_url: string;
}

interface GitlabMergeRequestDetail {
  iid: number;
  title: string;
  web_url: string;
}

function validateGitlabMergeRequest(mr: GitlabMergeRequest, context: string): GitlabMergeRequest {
  if (!Number.isInteger(mr.iid) || typeof mr.web_url !== "string" || mr.web_url.trim() === "") {
    throw new Error(`GitLab merge request ${context} returned invalid metadata`);
  }
  return mr;
}

function encodeProjectId(slug: string): string {
  return encodeURIComponent(slug);
}

export function createGitlabMergeRequestProvider(fetchImpl: FetchLike = fetch): MergeRequestProvider {
  return {
    id: "gitlab",
    async createMergeRequest(input: MergeRequestInput, token: string): Promise<MergeRequestResult> {
      const projectId = encodeProjectId(input.repo.slug);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      };
      const baseUrl = `https://gitlab.com/api/v4/projects/${projectId}/merge_requests`;

      const listUrl = `${baseUrl}?source_branch=${encodeURIComponent(input.sourceBranch)}&state=opened`;
      const listResponse = await fetchImpl(listUrl, { headers });
      if (!listResponse.ok) {
        throw new Error(`GitLab merge request lookup failed (${listResponse.status})`);
      }
      const existing = (await listResponse.json()) as GitlabMergeRequest[];
      if (existing.length > 0 && existing[0]) {
        const mr = validateGitlabMergeRequest(existing[0], "lookup");
        return {
          url: mr.web_url,
          number: mr.iid,
          provider: "gitlab",
          created: false
        };
      }

      // Opened as a draft via the title prefix; the harness removes the prefix
      // (marking the MR ready) only at the final handoff after review accepts.
      const createResponse = await fetchImpl(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: `${GITLAB_DRAFT_PREFIX}${input.title}`,
          description: input.description,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch
        })
      });

      if (createResponse.status === 409 || createResponse.status === 422) {
        const retry = await fetchImpl(listUrl, { headers });
        if (retry.ok) {
          const retryExisting = (await retry.json()) as GitlabMergeRequest[];
          if (retryExisting.length > 0 && retryExisting[0]) {
            const mr = validateGitlabMergeRequest(retryExisting[0], "lookup");
            return {
              url: mr.web_url,
              number: mr.iid,
              provider: "gitlab",
              created: false
            };
          }
        }
      }

      if (!createResponse.ok) {
        const detail = await createResponse.text().catch(() => "");
        throw new Error(`GitLab merge request creation failed (${createResponse.status})${detail ? `: ${detail}` : ""}`);
      }

      const created = (await createResponse.json()) as GitlabMergeRequest;
      const mr = validateGitlabMergeRequest(created, "creation");
      return {
        url: mr.web_url,
        number: mr.iid,
        provider: "gitlab",
        created: true
      };
    },

    async markReady(input: MergeRequestReadyInput, token: string): Promise<void> {
      const projectId = encodeProjectId(input.repo.slug);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      };
      const detailUrl = `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${input.number}`;

      const detailResponse = await fetchImpl(detailUrl, { headers });
      if (!detailResponse.ok) {
        throw new Error(`GitLab merge request lookup failed (${detailResponse.status})`);
      }
      const detail = (await detailResponse.json()) as GitlabMergeRequestDetail;
      const readyTitle = detail.title.replace(GITLAB_DRAFT_TITLE_PATTERN, "");
      if (readyTitle === detail.title) return;

      const updateResponse = await fetchImpl(detailUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify({ title: readyTitle })
      });
      if (!updateResponse.ok) {
        const errorDetail = await updateResponse.text().catch(() => "");
        throw new Error(
          `GitLab merge request ready update failed (${updateResponse.status})${errorDetail ? `: ${errorDetail}` : ""}`
        );
      }
    }
  };
}
