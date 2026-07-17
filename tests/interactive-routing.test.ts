import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { loadAgentConfig } from "../src/core/agents/config/store.ts";
import { createRunnerForRouting } from "../src/runners/index.ts";
import { InteractiveAgentRunner } from "../src/runners/interactive.ts";
import { HeadlessAgentRunner } from "../src/runners/headless.ts";
import { AcpAgentRunner } from "../src/runners/acp/runner.ts";

describe("createRunnerForRouting dual-mode", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-route-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function firstNonAcpRouting(): Promise<{ toolId: string; modelPoolId: string }> {
    const config = await loadAgentConfig(root);
    const tool = config.tools.find((t) => t.enabled && t.adapter !== "acp");
    if (!tool) throw new Error("no non-ACP tool seeded");
    const pool = config.pools.find((p) => p.toolId === tool.id && p.enabled);
    if (!pool) throw new Error(`no pool for ${tool.id}`);
    return { toolId: tool.id, modelPoolId: pool.id };
  }

  it("uses InteractiveAgentRunner for conversation and agent_turn steps", async () => {
    const routing = await firstNonAcpRouting();
    const conversation = await createRunnerForRouting(root, routing, {
      stepContext: { stepKind: "conversation", reviewer: false, checksRemediation: false }
    });
    expect(conversation).toBeInstanceOf(InteractiveAgentRunner);

    const author = await createRunnerForRouting(root, routing, {
      stepContext: { stepKind: "agent_turn", reviewer: false, checksRemediation: false }
    });
    expect(author).toBeInstanceOf(InteractiveAgentRunner);
  });

  it("uses headless for remediation and when interactive is forced off", async () => {
    const routing = await firstNonAcpRouting();
    const rem = await createRunnerForRouting(root, routing, {
      stepContext: { stepKind: "agent_turn", reviewer: false, checksRemediation: true }
    });
    expect(rem).toBeInstanceOf(HeadlessAgentRunner);

    const forced = await createRunnerForRouting(root, routing, {
      interactive: false,
      stepContext: { stepKind: "conversation" }
    });
    expect(forced).toBeInstanceOf(HeadlessAgentRunner);
  });

  it("keeps ACP on the JSON-RPC runner even for conversation steps", async () => {
    const config = await loadAgentConfig(root);
    const tool = config.tools.find((t) => t.enabled && t.adapter === "acp");
    if (!tool) return; // optional seed
    const pool = config.pools.find((p) => p.toolId === tool.id && p.enabled);
    if (!pool) return;
    const runner = await createRunnerForRouting(
      root,
      { toolId: tool.id, modelPoolId: pool.id },
      { stepContext: { stepKind: "conversation" } }
    );
    expect(runner).toBeInstanceOf(AcpAgentRunner);
  });
});
