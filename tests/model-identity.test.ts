import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { normalizeBundle, normalizeModelPool, normalizeTool } from "../src/core/agents/config/normalize.ts";
import { resolveRunIdentityFromRouting } from "../src/core/agents/config/run-identity.ts";
import {
  extractConfiguredModel,
  inferProviderFromModel,
  resolveRunModelIdentity
} from "../src/core/agents/config/model-identity.ts";
import { createRun, listRuns } from "../src/core/tasks/runs.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../src/core/agents/config/types.ts";

function makeTool(overrides: Partial<AgentToolConfig> & { id: string }): AgentToolConfig {
  return normalizeTool({
    command: overrides.id,
    adapter: "generic",
    ...overrides
  });
}

function makePool(
  id: string,
  toolId: string,
  overrides: Partial<ModelPoolConfig> & { modelArgs?: string[]; modelEnv?: Record<string, string> } = {}
): ModelPoolConfig {
  return normalizeModelPool({
    id,
    toolId,
    capabilities: ["author"],
    tier: "paid",
    ...overrides
  });
}

function finalizePool(tool: AgentToolConfig, pool: ModelPoolConfig): ModelPoolConfig {
  return normalizeBundle({ tools: [tool], pools: [pool] }).pools[0]!;
}

describe("model identity extraction", () => {
  it("reads configured model from --model args", () => {
    expect(extractConfiguredModel(["--model", "claude-sonnet-5"])).toBe("claude-sonnet-5");
    expect(extractConfiguredModel([])).toBe("(default)");
  });

  it("infers provider families from model ids", () => {
    expect(inferProviderFromModel("claude-sonnet-5")).toBe("anthropic");
    expect(inferProviderFromModel("gpt-5.5-medium")).toBe("openai");
    expect(inferProviderFromModel("grok-composer-2.5")).toBe("grok");
    expect(inferProviderFromModel("composer-2.5")).toBe("composer");
    expect(inferProviderFromModel("glm-5.2")).toBe("glm");
  });
});

describe("model pool identity normalization", () => {
  it("marks native claude pools as verified anthropic", () => {
    const tool = makeTool({ id: "claude", adapter: "claude" });
    const pool = finalizePool(
      tool,
      makePool("claude-sonnet-5", "claude", {
        modelArgs: ["--model", "claude-sonnet-5"],
        usageSource: "claude-oauth"
      })
    );
    expect(pool.identity!).toMatchObject({
      provider: "anthropic",
      configuredModel: "claude-sonnet-5",
      verificationState: "verified"
    });
  });

  it("marks proxied glm on claude harness as glm with endpoint proof", () => {
    const tool = makeTool({ id: "claude", adapter: "claude" });
    const pool = finalizePool(
      tool,
      makePool("claude-glm", "claude", {
        modelArgs: ["--model", "glm-5.2"],
        modelEnv: { ANTHROPIC_BASE_URL: "https://api.z.ai/v1" },
        identity: {
          provider: "glm",
          configuredModel: "glm-5.2",
          verificationState: "verified",
          endpointProof: "https://api.z.ai/v1"
        }
      })
    );
    expect(pool.identity!).toMatchObject({
      provider: "glm",
      configuredModel: "glm-5.2",
      verificationState: "verified",
      endpointProof: "https://api.z.ai/v1"
    });
  });

  it("marks no-arg default pools as unknown verification", () => {
    const tool = makeTool({ id: "grok", adapter: "grok" });
    const pool = finalizePool(tool, makePool("grok-default", "grok"));
    expect(pool.identity!.configuredModel).toBe("(default)");
    expect(pool.identity!.verificationState).toBe("unknown");
  });

  it("allows cross-provider pools and marks them unverified", () => {
    const tool = makeTool({ id: "grok", adapter: "grok" });
    const bundle = normalizeBundle({
      tools: [tool],
      pools: [makePool("grok-composer-cross", "grok", { modelArgs: ["--model", "composer-2.5"] })]
    });
    const pool = bundle.pools[0]!;
    expect(pool.identity!.provider).toBe("composer");
    expect(pool.identity!.verificationState).toBe("unverified");
  });

  it("allows native grok-composer under grok harness", () => {
    const tool = makeTool({ id: "grok", adapter: "grok" });
    const pool = finalizePool(
      tool,
      makePool("grok-composer", "grok", { modelArgs: ["--model", "grok-composer-2.5"] })
    );
    expect(pool.identity!.provider).toBe("grok");
    expect(pool.identity!.verificationState).toBe("verified");
  });

  it("allows composer under cursor harness", () => {
    const tool = makeTool({ id: "cursor", adapter: "acp" });
    const pool = finalizePool(
      tool,
      makePool("cursor-composer", "cursor", { modelArgs: ["--model", "composer-2.5"] })
    );
    expect(pool.identity!.provider).toBe("composer");
    expect(pool.identity!.verificationState).toBe("verified");
  });

  it("allows glm model on claude harness and marks it unverified", () => {
    const tool = makeTool({ id: "claude", adapter: "claude" });
    const pool = finalizePool(
      tool,
      makePool("claude-glm-cross", "claude", { modelArgs: ["--model", "glm-5.2"] })
    );
    expect(pool.identity!.provider).toBe("glm");
    expect(pool.identity!.verificationState).toBe("unverified");
  });
});

describe("resolved run identity", () => {
  it("captures harness, provider, models, and verification", () => {
    const tool = makeTool({ id: "claude", adapter: "claude" });
    const pool = finalizePool(
      tool,
      makePool("claude-sonnet-5", "claude", {
        modelArgs: ["--model", "claude-sonnet-5"]
      })
    );
    const resolved = resolveRunModelIdentity(tool, pool);
    expect(resolved).toMatchObject({
      harness: "claude",
      provider: "anthropic",
      configuredModel: "claude-sonnet-5",
      resolvedModel: "claude-sonnet-5",
      verificationState: "verified"
    });
  });

  it("persists resolved identity on run records without breaking older runs", async () => {
    let root: string;
    root = await mkdtemp(path.join(tmpdir(), "harness-model-identity-"));
    await ensureHarnessRepository(root);
    try {
      const legacy = await createRun(root, {
        taskId: "task-legacy",
        taskTitle: "Legacy",
        agent: "claude",
        status: "completed",
        startedAt: new Date().toISOString(),
        artifacts: [],
        modelPoolId: "claude-default"
      });
      expect(legacy.resolvedIdentity).toBeUndefined();

      const resolved = resolveRunModelIdentity(makeTool({ id: "claude", adapter: "claude" }), {
        ...finalizePool(makeTool({ id: "claude", adapter: "claude" }), makePool("claude-default", "claude")),
        id: "claude-default",
        toolId: "claude",
        displayName: "Claude (default)",
        modelArgs: [],
        modelEnv: {},
        capabilities: [],
        tier: "paid",
        usage: { kind: "usage-only" },
        usageSource: "claude-oauth",
        enabled: true,
        builtin: true
      });
      const modern = await createRun(root, {
        taskId: "task-modern",
        taskTitle: "Modern",
        agent: "claude",
        status: "completed",
        startedAt: new Date().toISOString(),
        artifacts: [],
        modelPoolId: "claude-default",
        resolvedIdentity: resolved
      });
      expect(modern.resolvedIdentity?.harness).toBe("claude");

      const runs = await listRuns(root);
      expect(runs).toHaveLength(2);
      expect(runs.find((run) => run.id === legacy.id)?.resolvedIdentity).toBeUndefined();
      expect(runs.find((run) => run.id === modern.id)?.resolvedIdentity?.provider).toBe("anthropic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves identity from routing via harness config", async () => {
    let root: string;
    root = await mkdtemp(path.join(tmpdir(), "harness-model-identity-route-"));
    await ensureHarnessRepository(root);
    try {
      const identity = await resolveRunIdentityFromRouting(root, "claude", "claude-sonnet-5");
      expect(identity).toMatchObject({
        harness: "claude",
        provider: "anthropic",
        configuredModel: "claude-sonnet-5",
        resolvedModel: "claude-sonnet-5"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
