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

      const state = await getMergeRequestState({
        root,
        repoPath: repoDir,
        provider: "github",
        number: 7
      });

      expect(state).toBe("merged");
    } finally {
      vi.unstubAllGlobals();
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});