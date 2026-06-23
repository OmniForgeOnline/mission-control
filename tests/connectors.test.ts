import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConnectorsState } from "../src/connectors/connections.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("connectors state", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-connectors-state-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes connector providers and connections without secrets", async () => {
    const state = await loadConnectorsState(root);
    expect(state.providers.map((provider) => provider.id)).toEqual(["github", "gitlab", "clickup"]);
    expect(state.providers[0]?.tokenHint).toContain("token");
    expect(state.connections).toEqual([]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/gho_[A-Za-z0-9]|ghp_[A-Za-z0-9]|github_pat_/);
    expect(serialized).not.toContain("client_secret");
  });
});