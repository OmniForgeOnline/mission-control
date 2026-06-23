import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";

import { createServer } from "../src/server/app.ts";
import { setGhExecImpl, resetGhExecImpl } from "../src/connectors/auth/gh-cli.ts";
import { MemoryConnectorVault } from "../src/connectors/vault/memory.ts";
import { saveConnection } from "../src/connectors/store.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("connectors API", () => {
  let root: string;
  const vault = new MemoryConnectorVault();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-connectors-api-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    resetGhExecImpl();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("lists providers with token-first capabilities", async () => {
    const app = createServer({ root, testMode: true, vault });
    const state = await request(app).get("/api/state").expect(200);
    expect(state.body.connectors.providers).toHaveLength(3);
    expect(state.body.connectors.connections).toEqual([]);
  });

  it("connects with a personal token", async () => {
    const app = createServer({ root, testMode: true, vault });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).includes("api.github.com/user")) {
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return originalFetch(input);
    };

    try {
      const connected = await request(app)
        .post("/api/connectors/github/connect")
        .send({ method: "token", token: "ghp_test_token" })
        .expect(200);
      expect(connected.body.providerId).toBe("github");
      expect(connected.body.authMethod).toBe("token");
      expect(connected.body.accountLabel).toBe("octocat");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("connects github via the local gh cli session", async () => {
    setGhExecImpl(async (_file, args) => {
      if (args[0] === "auth" && args[1] === "status") {
        return { stdout: "Logged in to github.com", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "token") {
        return { stdout: "gh-cli-token\n", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });

    const app = createServer({ root, testMode: true, vault });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).includes("api.github.com/user")) {
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return originalFetch(input);
    };

    try {
      const connected = await request(app)
        .post("/api/connectors/github/connect")
        .send({ method: "gh" })
        .expect(200);
      expect(connected.body.authMethod).toBe("gh_cli");
      expect(connected.body.accountLabel).toBe("octocat");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("imports tasks from all repos and auto-binds local clones", async () => {
    const app = createServer({ root, testMode: true, vault });
    const connection = await saveConnection(root, {
      id: "conn-github",
      providerId: "github",
      status: "connected",
      authMethod: "token",
      accountLabel: "octocat",
      connectedAt: new Date().toISOString(),
      config: {}
    });
    await vault.set(connection.id, { accessToken: "github-token" });

    const { loadHarnessSettings, updateHarnessSettings } = await import("../src/core/settings.ts");
    const settings = await loadHarnessSettings(root);
    const projectsRoot = path.join(root, "projects");
    await updateHarnessSettings(root, { ...settings, projectsRoot });

    const repoDir = path.join(projectsRoot, "hello-world");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("mkdir", ["-p", projectsRoot]);
    await execFileAsync("git", ["init", repoDir]);
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], {
      cwd: repoDir
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/user/repos")) {
        return new Response(
          JSON.stringify([{ full_name: "octocat/hello-world", owner: { login: "octocat" }, name: "hello-world" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/repos/octocat/hello-world/issues")) {
        return new Response(
          JSON.stringify([
            { number: 1, title: "First issue", html_url: "https://github.com/octocat/hello-world/issues/1" }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return originalFetch(input);
    };

    try {
      const imported = await request(app).post(`/api/connectors/${connection.id}/import`).expect(201);
      expect(imported.body).toHaveLength(1);
      expect(imported.body[0].source).toBe("github");
      expect(imported.body[0].title).toContain("First issue");
      expect(imported.body[0].targets[0].path).toBe(repoDir);
      expect(imported.body[0].description).toContain(repoDir);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serves cached ClickUp lists until explicitly refreshed", async () => {
    const app = createServer({ root, testMode: true, vault });
    const connection = await saveConnection(root, {
      id: "conn-clickup",
      providerId: "clickup",
      status: "connected",
      authMethod: "token",
      accountLabel: "Workspace",
      connectedAt: new Date().toISOString(),
      config: {
        clickup: {
          cachedResources: [{ id: "cached-list", label: "Cached / List", meta: { teamId: "team-1", listId: "cached-list" } }],
          resourcesSyncedAt: "2026-06-19T00:00:00.000Z"
        }
      }
    });
    await vault.set(connection.id, { accessToken: "clickup-token" });

    let remoteCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.clickup.com")) {
        remoteCalls += 1;
        if (url.endsWith("/team")) {
          return new Response(JSON.stringify({ teams: [{ id: "team-1", name: "Team" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/team/team-1/space")) {
          return new Response(JSON.stringify({ spaces: [{ id: "space-1", name: "Space" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/space/space-1/folder")) {
          return new Response(JSON.stringify({ folders: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/space/space-1/list")) {
          return new Response(JSON.stringify({ lists: [{ id: "fresh-list", name: "Fresh List" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      return originalFetch(input);
    };

    try {
      const cached = await request(app).get(`/api/connectors/${connection.id}/resources`).expect(200);
      expect(cached.body).toEqual([
        { id: "cached-list", label: "Cached / List", meta: { teamId: "team-1", listId: "cached-list" } }
      ]);
      expect(remoteCalls).toBe(0);

      const refreshed = await request(app).get(`/api/connectors/${connection.id}/resources?refresh=1`).expect(200);
      expect(refreshed.body[0]).toMatchObject({ id: "fresh-list", label: "Team / Space / Fresh List" });
      expect(remoteCalls).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
