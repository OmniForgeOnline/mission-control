import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectWithToken } from "../src/connectors/connections.ts";
import { getMergeRequestState } from "../src/core/merge-request/status.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("merge request status", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-mr-status-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports merged GitHub pull requests", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/pulls/7")) {
          return new Response(JSON.stringify({ state: "closed", merged: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-mr-status-repo-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", ["init"], { cwd: repoDir });
      await exec("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: repoDir });

      const result = await getMergeRequestState({
        root,
        repoPath: repoDir,
        provider: "github",
        number: 7
      });

      expect(result.state).toBe("merged");
    } finally {
      vi.unstubAllGlobals();
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("resolves state from the merge-request URL when repoPath has no remote", async () => {
    await connectWithToken(root, "github", "ghp_testtoken", {
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/pulls/19")) {
          return new Response(JSON.stringify({ state: "closed", merged: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );

    // repoPath is a non-repo directory; identity must come from the stored URL.
    // This is the #15/#16 scenario: the checkout moved, the URL did not.
    const deadDir = await mkdtemp(path.join(tmpdir(), "harness-mr-noremote-"));
    try {
      const result = await getMergeRequestState({
        root,
        repoPath: deadDir,
        url: "https://github.com/OmniForgeOnline/mission-control/pull/19",
        provider: "github",
        number: 19
      });

      expect(result.state).toBe("merged");
    } finally {
      vi.unstubAllGlobals();
      await rm(deadDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns no_remote when neither url nor repoPath resolves", async () => {
    const result = await getMergeRequestState({
      root,
      repoPath: "/nonexistent/path",
      provider: "github",
      number: 1
    });
    expect(result).toEqual({ state: null, reason: "no_remote", detail: "/nonexistent/path" });
  });

  it("returns host_mismatch when the URL host contradicts the provider", async () => {
    const result = await getMergeRequestState({
      root,
      repoPath: "/nonexistent/path",
      url: "https://gitlab.com/group/project/-/merge_requests/3",
      provider: "github",
      number: 3
    });
    expect(result).toEqual({ state: null, reason: "host_mismatch" });
  });

  it("returns auth_missing when no connector token is configured", async () => {
    const result = await getMergeRequestState({
      root,
      repoPath: "/nonexistent/path",
      url: "https://github.com/acme/repo/pull/5",
      provider: "github",
      number: 5
    });
    expect(result).toEqual({ state: null, reason: "auth_missing", detail: "GitHub" });
  });
});