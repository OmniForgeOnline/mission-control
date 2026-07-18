import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectWithToken, disconnectConnector } from "../src/connectors/connections.ts";
import { MemoryConnectorVault } from "../src/connectors/vault/memory.ts";
import { listAutonomyJobs } from "../src/autonomy/jobs.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("connector token auth", () => {
  let root: string;
  const vault = new MemoryConnectorVault();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-connectors-token-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores validated personal tokens in the vault", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).includes("api.clickup.com/api/v2/team")) {
        return new Response(JSON.stringify({ teams: [{ id: "1", name: "Workspace" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return originalFetch(input);
    };

    try {
      const connection = await connectWithToken(root, "clickup", "pk_test_token", { vault });
      expect(connection.authMethod).toBe("token");
      expect(connection.accountLabel).toBe("Workspace");
      expect((await vault.get(connection.id))?.accessToken).toBe("pk_test_token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("activates clickup-ticket-sync on connect and pauses it on disconnect", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).includes("api.clickup.com/api/v2/team")) {
        return new Response(JSON.stringify({ teams: [{ id: "1", name: "Workspace" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return originalFetch(input);
    };

    try {
      const before = (await listAutonomyJobs(root)).find((job) => job.id === "clickup-ticket-sync");
      expect(before?.status).toBe("paused");

      const connection = await connectWithToken(root, "clickup", "pk_test_token", { vault });
      const active = (await listAutonomyJobs(root)).find((job) => job.id === "clickup-ticket-sync");
      expect(active?.status).toBe("active");

      await disconnectConnector(root, connection.id, { vault });
      const paused = (await listAutonomyJobs(root)).find((job) => job.id === "clickup-ticket-sync");
      expect(paused?.status).toBe("paused");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not activate clickup-ticket-sync when connecting GitHub", async () => {
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
      await connectWithToken(root, "github", "ghp_test_token", { vault });
      const job = (await listAutonomyJobs(root)).find((entry) => entry.id === "clickup-ticket-sync");
      expect(job?.status).toBe("paused");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
