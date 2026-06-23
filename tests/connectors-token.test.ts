import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectWithToken } from "../src/connectors/connections.ts";
import { MemoryConnectorVault } from "../src/connectors/vault/memory.ts";
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
});