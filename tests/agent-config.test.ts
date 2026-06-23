import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  normalizeBundle,
  normalizeModelPool,
  normalizeTool,
  normalizeUsagePolicy
} from "../src/core/agents/config/normalize.ts";
import {
  loadAgentConfig,
  removeModelPool,
  removeTool,
  saveAgentConfig,
  upsertModelPool,
  upsertRoutingProfile,
  upsertTool
} from "../src/core/agents/config/store.ts";
import type { AgentToolConfig, ModelPoolConfig } from "../src/core/agents/config/types.ts";
import {
  loadUsageSnapshots,
  saveUsageSnapshots,
  upsertUsageSnapshot
} from "../src/core/agents/config/usage-store.ts";

function makeTool(id: string): AgentToolConfig {
  return normalizeTool({ id, displayName: id, command: id, adapter: "generic" });
}

function makePool(id: string, toolId: string): ModelPoolConfig {
  return normalizeModelPool({ id, toolId, capabilities: ["author"], qualityWeight: 60, tier: "free" });
}

describe("agent config normalization", () => {
  it("accepts arbitrary tool and model pool ids", () => {
    const tool = normalizeTool({ id: "kilo-cli", command: "kilo", adapter: "generic" });
    expect(tool.id).toBe("kilo-cli");
    expect(tool.adapter).toBe("generic");
    const pool = normalizeModelPool({ id: "kilo.free", toolId: "kilo-cli", tier: "free" });
    expect(pool.id).toBe("kilo.free");
    expect(pool.tier).toBe("free");
  });

  it("rejects invalid identifiers", () => {
    expect(() => normalizeTool({ id: "bad id", command: "x" })).toThrow();
  });

  it("normalizes a capless 'unavailable' usage policy with no fake limit", () => {
    const usage = normalizeUsagePolicy({ kind: "unavailable" }, "test");
    expect(usage).toEqual({ kind: "unavailable" });
    expect((usage as { limit?: number }).limit).toBeUndefined();
  });

  it("requires a positive limit for quota policies", () => {
    expect(() => normalizeUsagePolicy({ kind: "quota", period: "weekly" }, "test")).toThrow(/limit/);
    const ok = normalizeUsagePolicy({ kind: "quota", period: "monthly", limit: 50 }, "test");
    expect(ok).toMatchObject({ kind: "quota", period: "monthly", limit: 50 });
  });

  it("rejects pools that reference an unknown tool", () => {
    expect(() =>
      normalizeBundle({ tools: [makeTool("codex")], pools: [makePool("ghost", "missing")] })
    ).toThrow(/unknown tool/);
  });

  it("rejects duplicate tool ids", () => {
    expect(() => normalizeBundle({ tools: [makeTool("codex"), makeTool("codex")] })).toThrow(/Duplicate/);
  });

  it("normalizes runtime metadata for launch, prompt transport, probing, and MCP", () => {
    const tool = normalizeTool({
      id: "claude",
      command: "claude",
      adapter: "claude",
      promptTransport: "stdin",
      promptInputFormat: "stream-json",
      streamFormat: "claude-stream-json",
      eventParser: "claude",
      externalMcpInjection: "claude-mcp-json",
      fallbackCommands: ["openclaude"],
      versionArgs: ["--version"],
      helpArgs: ["-p", "--help"],
      capabilityFlags: { "--include-partial-messages": "partialMessages" },
      authProbe: { args: ["status"], timeoutMs: 1200 },
      supportsCustomModel: false,
      inactivityTimeoutMs: 30_000,
      resumesSessionViaCli: true
    });
    expect(tool.promptTransport).toBe("stdin");
    expect(tool.promptInputFormat).toBe("stream-json");
    expect(tool.streamFormat).toBe("claude-stream-json");
    expect(tool.eventParser).toBe("claude");
    expect(tool.externalMcpInjection).toBe("claude-mcp-json");
    expect(tool.fallbackCommands).toEqual(["openclaude"]);
    expect(tool.versionArgs).toEqual(["--version"]);
    expect(tool.helpArgs).toEqual(["-p", "--help"]);
    expect(tool.capabilityFlags).toEqual({ "--include-partial-messages": "partialMessages" });
    expect(tool.authProbe).toEqual({ args: ["status"], timeoutMs: 1200 });
    expect(tool.supportsCustomModel).toBe(false);
    expect(tool.inactivityTimeoutMs).toBe(30_000);
    expect(tool.resumesSessionViaCli).toBe(true);
  });

  it("rejects invalid runtime metadata", () => {
    expect(() => normalizeTool({ id: "x", command: "x", promptTransport: "socket" })).toThrow(/promptTransport/);
    expect(() => normalizeTool({ id: "x", command: "x", inactivityTimeoutMs: -1 })).toThrow(/inactivityTimeoutMs/);
    expect(() => normalizeTool({ id: "x", command: "x", maxPromptArgBytes: 0 })).toThrow(/maxPromptArgBytes/);
    expect(() => normalizeTool({ id: "x", command: "x", authProbe: { args: "status" } })).toThrow(/authProbe.args/);
  });
});

describe("agent config store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-agent-config-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seeds built-in tools and pools on first load", async () => {
    const bundle = await loadAgentConfig(root);
    expect(bundle.tools.map((tool) => tool.id).sort()).toEqual(["claude", "codex", "grok", "kiro", "opencode"]);
    const unsupportedTools = ["grok", "kiro", "opencode"];
    for (const id of unsupportedTools) {
      expect(bundle.tools.find((tool) => tool.id === id)?.usage).toEqual({ kind: "unavailable" });
      expect(bundle.pools.find((pool) => pool.toolId === id)?.usage).toEqual({ kind: "unavailable" });
      expect(bundle.pools.find((pool) => pool.toolId === id)?.usageSource).toBe("none");
    }
    expect(bundle.tools.find((tool) => tool.id === "codex")?.usage).toMatchObject({ kind: "usage-only" });
    const claude = bundle.tools.find((tool) => tool.id === "claude")!;
    expect(claude.usage.kind).toBe("usage-only");
  });

  it("is idempotent across reloads", async () => {
    const first = await loadAgentConfig(root);
    const second = await loadAgentConfig(root);
    expect(second).toEqual(first);
  });

  it("replaces stale built-in usage metadata on reload", async () => {
    const bundle = await loadAgentConfig(root);
    await saveAgentConfig(root, {
      ...bundle,
      tools: bundle.tools.map((tool) =>
        tool.id === "grok"
          ? { ...tool, usage: { kind: "quota", period: "monthly", limit: 100, softThresholdPercent: 80 } }
          : tool
      ),
      pools: bundle.pools.map((pool) =>
        pool.id === "opencode-default"
          ? {
              ...pool,
              usage: { kind: "quota", period: "monthly", limit: 100, softThresholdPercent: 80 },
              usageSource: "claude-oauth"
            }
          : pool
      )
    });

    const reloaded = await loadAgentConfig(root);
    expect(reloaded.tools.find((tool) => tool.id === "grok")?.usage).toEqual({ kind: "unavailable" });
    expect(reloaded.pools.find((pool) => pool.id === "opencode-default")?.usage).toEqual({ kind: "unavailable" });
    expect(reloaded.pools.find((pool) => pool.id === "opencode-default")?.usageSource).toBe("none");
  });

  it("supports CRUD on tools and pools while protecting built-ins", async () => {
    await loadAgentConfig(root);
    await upsertTool(root, makeTool("kilo-cli"));
    await upsertModelPool(root, makePool("kilo-free", "kilo-cli"));
    let bundle = await loadAgentConfig(root);
    expect(bundle.tools.some((tool) => tool.id === "kilo-cli")).toBe(true);
    expect(bundle.pools.some((pool) => pool.id === "kilo-free")).toBe(true);

    await expect(removeTool(root, "codex")).rejects.toThrow(/built-in/);

    await removeModelPool(root, "kilo-free");
    bundle = await removeTool(root, "kilo-cli");
    expect(bundle.tools.some((tool) => tool.id === "kilo-cli")).toBe(false);
  });

  it("cascades pool deletion when a tool is removed", async () => {
    await loadAgentConfig(root);
    await upsertTool(root, makeTool("warp"));
    await upsertModelPool(root, makePool("warp-fast", "warp"));
    const bundle = await removeTool(root, "warp");
    expect(bundle.pools.some((pool) => pool.id === "warp-fast")).toBe(false);
  });

  it("upserts routing profiles", async () => {
    await loadAgentConfig(root);
    const bundle = await upsertRoutingProfile(root, {
      role: "author",
      minQuality: 70,
      requiredCapability: "code"
    });
    const profile = bundle.profiles.find((entry) => entry.role === "author")!;
    expect(profile.minQuality).toBe(70);
    expect(profile.requiredCapability).toBe("code");
  });

  it("saves a full bundle atomically", async () => {
    const bundle = await loadAgentConfig(root);
    const saved = await saveAgentConfig(root, {
      ...bundle,
      tools: [...bundle.tools, makeTool("warp")]
    });
    expect(saved.tools.some((tool) => tool.id === "warp")).toBe(true);
    const reloaded = await loadAgentConfig(root);
    expect(reloaded.tools.some((tool) => tool.id === "warp")).toBe(true);
  });

  it("stores and replaces usage snapshots per tool and pool", async () => {
    expect((await loadUsageSnapshots(root)).snapshots).toEqual([]);
    await upsertUsageSnapshot(root, {
      toolId: "codex",
      modelPoolId: "codex-default",
      used: 10,
      fetchedAt: new Date().toISOString(),
      source: "harness"
    });
    await upsertUsageSnapshot(root, {
      toolId: "codex",
      modelPoolId: "codex-default",
      used: 25,
      fetchedAt: new Date().toISOString(),
      source: "harness"
    });
    const usage = await loadUsageSnapshots(root);
    const codex = usage.snapshots.filter((entry) => entry.toolId === "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]!.used).toBe(25);

    await saveUsageSnapshots(root, { snapshots: [], refreshedAt: new Date().toISOString() });
    expect((await loadUsageSnapshots(root)).snapshots).toEqual([]);
  });
});

describe("agent config change set", () => {
  it("normalizes a capless Claude Code + Z.ai GLM-5.1 pool without inventing a limit", () => {
    const pool = normalizeModelPool({
      id: "claude-zai-glm",
      toolId: "claude",
      displayName: "Claude on Z.ai GLM-5.1",
      modelArgs: ["--model", "glm-5.1"],
      modelEnv: { ANTHROPIC_BASE_URL: "https://api.z.ai" },
      capabilities: ["author", "reviewer"],
      qualityWeight: 75,
      tier: "paid",
      usage: { kind: "unavailable" }
    });
    expect(pool.usage).toEqual({ kind: "unavailable" });

    const bundle = normalizeBundle({ tools: [makeTool("claude")], pools: [pool] });
    expect(bundle.pools.some((p) => p.id === "claude-zai-glm")).toBe(true);
  });
});
