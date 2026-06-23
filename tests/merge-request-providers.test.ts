import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectWithToken } from "../src/connectors/connections.ts";
import { createGithubMergeRequestProvider } from "../src/core/merge-request/github.ts";
import { createGitlabMergeRequestProvider } from "../src/core/merge-request/gitlab.ts";
import {
  createMergeRequestForRepo,
  hostToProviderId,
  readOriginRemote
} from "../src/core/merge-request/index.ts";
import { parseRemoteRepoRef } from "../src/connectors/repo-bind.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { MemoryConnectorVault } from "../src/connectors/vault/memory.ts";

describe("merge request providers", () => {
  let root: string;
  const vault = new MemoryConnectorVault();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-mr-providers-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("maps supported hosts to provider ids", () => {
    expect(hostToProviderId("github.com")).toBe("github");
    expect(hostToProviderId("gitlab.com")).toBe("gitlab");
  });

  it("parses remote repo refs for provider selection", () => {
    expect(parseRemoteRepoRef("git@github.com:octocat/hello-world.git")).toEqual({
      host: "github.com",
      slug: "octocat/hello-world"
    });
    expect(parseRemoteRepoRef("https://gitlab.com/group/project.git")).toEqual({
      host: "gitlab.com",
      slug: "group/project"
    });
  });

  it("creates a GitHub pull request with duplicate reuse", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/pulls?") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/o/r/pull/42" }), {
          status: 201
        });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGithubMergeRequestProvider(fetchImpl as typeof fetch);
    const result = await provider.createMergeRequest(
      {
        repo: { host: "github.com", slug: "octocat/hello-world" },
        sourceBranch: "harness/abc",
        targetBranch: "main",
        title: "Add feature",
        description: "Details"
      },
      "token"
    );

    expect(result).toEqual({
      url: "https://github.com/o/r/pull/42",
      number: 42,
      provider: "github",
      created: true
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/octocat/hello-world/pulls",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Add feature",
          body: "Details",
          head: "harness/abc",
          base: "main",
          draft: true
        })
      })
    );
  });

  it("reuses an existing open GitHub pull request", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/pulls?")) {
        return new Response(JSON.stringify([{ number: 7, html_url: "https://github.com/o/r/pull/7" }]), {
          status: 200
        });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGithubMergeRequestProvider(fetchImpl as typeof fetch);
    const result = await provider.createMergeRequest(
      {
        repo: { host: "github.com", slug: "octocat/hello-world" },
        sourceBranch: "harness/abc",
        targetBranch: "main",
        title: "Add feature",
        description: "Details"
      },
      "token"
    );

    expect(result.created).toBe(false);
    expect(result.number).toBe(7);
  });

  it("reuses an existing open GitLab merge request after create conflict", async () => {
    let listCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("state=opened") && (!init || init.method === undefined)) {
        listCalls += 1;
        if (listCalls === 1) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(
          JSON.stringify([{ iid: 9, web_url: "https://gitlab.com/g/p/-/merge_requests/9" }]),
          { status: 200 }
        );
      }
      if (url.includes("/merge_requests") && init?.method === "POST") {
        return new Response("already exists", { status: 409 });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGitlabMergeRequestProvider(fetchImpl as typeof fetch);
    const result = await provider.createMergeRequest(
      {
        repo: { host: "gitlab.com", slug: "group/project" },
        sourceBranch: "harness/abc",
        targetBranch: "main",
        title: "Fix bug",
        description: "Details"
      },
      "token"
    );

    expect(result.created).toBe(false);
    expect(result.number).toBe(9);
  });

  it("creates a GitLab merge request", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("state=opened") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/merge_requests") && init?.method === "POST") {
        return new Response(JSON.stringify({ iid: 15, web_url: "https://gitlab.com/g/p/-/merge_requests/15" }), {
          status: 201
        });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGitlabMergeRequestProvider(fetchImpl as typeof fetch);
    const result = await provider.createMergeRequest(
      {
        repo: { host: "gitlab.com", slug: "group/project" },
        sourceBranch: "harness/abc",
        targetBranch: "main",
        title: "Fix bug",
        description: "Details"
      },
      "token"
    );

    expect(result).toEqual({
      url: "https://gitlab.com/g/p/-/merge_requests/15",
      number: 15,
      provider: "gitlab",
      created: true
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Draft: Fix bug",
          description: "Details",
          source_branch: "harness/abc",
          target_branch: "main"
        })
      })
    );
  });

  it("marks a draft GitHub pull request ready for review via GraphQL", async () => {
    const seenCalls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seenCalls.push({ url, ...(init?.body !== undefined ? { body: String(init.body) } : {}) });
      if (url.endsWith("/pulls/42") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ number: 42, draft: true, node_id: "PR_node_42" }), {
          status: 200
        });
      }
      if (url === "https://api.github.com/graphql" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_node_42" } } } }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGithubMergeRequestProvider(fetchImpl as typeof fetch);
    await provider.markReady(
      { repo: { host: "github.com", slug: "octocat/hello-world" }, number: 42 },
      "token"
    );

    const graphql = seenCalls.find((call) => call.url === "https://api.github.com/graphql");
    expect(graphql).toBeTruthy();
    expect(graphql?.body).toContain("markPullRequestReadyForReview");
    expect(graphql?.body).toContain("PR_node_42");
  });

  it("leaves an already-ready GitHub pull request untouched", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/pulls/42") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ number: 42, draft: false, node_id: "PR_node_42" }), {
          status: 200
        });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGithubMergeRequestProvider(fetchImpl as typeof fetch);
    await provider.markReady(
      { repo: { host: "github.com", slug: "octocat/hello-world" }, number: 42 },
      "token"
    );

    const graphqlCall = fetchImpl.mock.calls.find(
      ([url]) => url === "https://api.github.com/graphql"
    );
    expect(graphqlCall).toBeUndefined();
  });

  it("marks a draft GitLab merge request ready by stripping the prefix", async () => {
    const seenCalls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seenCalls.push({
        url,
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.body !== undefined ? { body: String(init.body) } : {})
      });
      if (url.endsWith("/merge_requests/15") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ iid: 15, title: "Draft: Fix bug", web_url: "u" }), {
          status: 200
        });
      }
      if (url.endsWith("/merge_requests/15") && init?.method === "PUT") {
        return new Response(JSON.stringify({ iid: 15, title: "Fix bug", web_url: "u" }), {
          status: 200
        });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGitlabMergeRequestProvider(fetchImpl as typeof fetch);
    await provider.markReady(
      { repo: { host: "gitlab.com", slug: "group/project" }, number: 15 },
      "token"
    );

    const put = seenCalls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests/15");
    expect(put?.body).toBe(JSON.stringify({ title: "Fix bug" }));
  });

  it("leaves an already-ready GitLab merge request untouched", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/merge_requests/15") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ iid: 15, title: "Fix bug", web_url: "u" }), {
          status: 200
        });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGitlabMergeRequestProvider(fetchImpl as typeof fetch);
    await provider.markReady(
      { repo: { host: "gitlab.com", slug: "group/project" }, number: 15 },
      "token"
    );

    const putCall = fetchImpl.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(putCall).toBeUndefined();
  });

  it("rejects malformed GitHub pull request creation responses", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/pulls?") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return new Response(JSON.stringify({ number: 42 }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGithubMergeRequestProvider(fetchImpl as typeof fetch);

    await expect(
      provider.createMergeRequest(
        {
          repo: { host: "github.com", slug: "octocat/hello-world" },
          sourceBranch: "harness/abc",
          targetBranch: "main",
          title: "Add feature",
          description: "Details"
        },
        "token"
      )
    ).rejects.toThrow("GitHub pull request creation returned invalid metadata");
  });

  it("rejects malformed GitLab merge request creation responses", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("state=opened") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/merge_requests") && init?.method === "POST") {
        return new Response(JSON.stringify({ web_url: "https://gitlab.com/g/p/-/merge_requests/15" }), {
          status: 201
        });
      }
      return new Response("not found", { status: 404 });
    });

    const provider = createGitlabMergeRequestProvider(fetchImpl as typeof fetch);

    await expect(
      provider.createMergeRequest(
        {
          repo: { host: "gitlab.com", slug: "group/project" },
          sourceBranch: "harness/abc",
          targetBranch: "main",
          title: "Fix bug",
          description: "Details"
        },
        "token"
      )
    ).rejects.toThrow("GitLab merge request creation returned invalid metadata");
  });

  it("fails with a clear message when auth is missing", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-noauth-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });

      await expect(
        createMergeRequestForRepo({
          root,
          repoPath: repoDir,
          sourceBranch: "harness/abc",
          targetBranch: "main",
          title: "Title",
          description: "Body"
        })
      ).rejects.toThrow(/Connect GitHub|Connect GitLab/);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("uses connected GitHub token for repo-backed creation", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
      vault
    });

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/pulls?") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return new Response(JSON.stringify({ number: 99, html_url: "https://github.com/o/r/pull/99" }), {
          status: 201
        });
      }
      return new Response("not found", { status: 404 });
    });

    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-repo-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });

      const remote = await readOriginRemote(repoDir);
      expect(remote).toContain("github.com");

      const result = await createMergeRequestForRepo({
        root,
        repoPath: repoDir,
        sourceBranch: "harness/abc",
        targetBranch: "main",
        title: "Harness change",
        description: "Body",
        fetchImpl: fetchImpl as typeof fetch,
        vault
      });

      expect(result.number).toBe(99);
      expect(result.provider).toBe("github");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
