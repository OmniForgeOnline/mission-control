import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteConnection,
  getConnection,
  listConnections,
  saveConnection,
  updateConnectionConfig
} from "../src/connectors/store.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("connector store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-connectors-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists and updates connector metadata without secrets", async () => {
    const connection = await saveConnection(root, {
      id: "conn-1",
      providerId: "github",
      status: "connected",
      authMethod: "token",
      accountLabel: "octocat",
      connectedAt: new Date().toISOString(),
      config: {}
    });

    expect(connection.accountLabel).toBe("octocat");
    expect(await listConnections(root)).toHaveLength(1);

    const updated = await updateConnectionConfig(root, "conn-1", {
      github: { owner: "octocat", repo: "hello-world" }
    });
    expect(updated.config.github).toEqual({ owner: "octocat", repo: "hello-world" });
    expect(JSON.stringify(await getConnection(root, "conn-1"))).not.toContain("gho_");

    expect(await deleteConnection(root, "conn-1")).toBe(true);
    expect(await listConnections(root)).toHaveLength(0);
  });
});