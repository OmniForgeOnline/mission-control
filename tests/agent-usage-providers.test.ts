import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import {
  mapCodexRateLimits,
  mapCodexModels,
  mapClaudeUsage,
  fetchPoolUsage,
  windowLabel,
  type UsageProviderDeps
} from "../src/core/agents/config/usage-providers.ts";
import { refreshUsageSnapshots } from "../src/core/agents/config/usage-refresh.ts";
import { loadUsageSnapshots } from "../src/core/agents/config/usage-store.ts";
import { capacityStatus } from "../src/core/agents/config/usage.ts";
import { normalizeModelPool, normalizeTool } from "../src/core/agents/config/normalize.ts";

const codexTool = normalizeTool({ id: "codex", command: "codex", adapter: "codex" });
const claudeTool = normalizeTool({ id: "claude", command: "claude", adapter: "claude" });

describe("usage provider mappers", () => {
  it("maps a codex model/list result into model entries", () => {
    const raw = {
      data: [
        { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true },
        { id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
        { id: "item-no-display", model: "gpt-bare" }
      ]
    };
    expect(mapCodexModels(raw)).toEqual([
      { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
      { id: "gpt-bare", displayName: "gpt-bare" }
    ]);
  });

  it("returns no models when the codex model/list result is malformed", () => {
    expect(mapCodexModels(null)).toEqual([]);
    expect(mapCodexModels({})).toEqual([]);
    expect(mapCodexModels({ data: "nope" })).toEqual([]);
  });

  it("maps codex rate limits to the most-constraining window", () => {
    const reading = mapCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 100 },
        secondary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: 200 }
      }
    });
    expect(reading).toEqual({ usedPercent: 97, windowMinutes: 10080, resetsAt: 200, windowLabel: "weekly" });
  });

  it("maps claude oauth usage to the most-constraining window", () => {
    const reading = mapClaudeUsage({
      five_hour: { utilization: 6, resets_at: "2026-01-01T00:00:00.000Z" },
      seven_day: { utilization: 35, resets_at: "2026-01-03T00:00:00.000Z" }
    });
    expect(reading?.usedPercent).toBe(35);
    expect(reading?.windowLabel).toBe("weekly");
    expect(reading?.resetsAt).toBe(Math.floor(Date.parse("2026-01-03T00:00:00.000Z") / 1000));
  });

  it("returns null for empty provider payloads", () => {
    expect(mapCodexRateLimits({})).toBeNull();
    expect(mapClaudeUsage({})).toBeNull();
  });

  it("labels common quota windows", () => {
    expect(windowLabel(10080)).toBe("weekly");
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(43200)).toBe("monthly");
  });
});

describe("fetchPoolUsage", () => {
  const deps: UsageProviderDeps = {
    fetchCodexRateLimits: async () => ({
      rateLimits: { secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 999 } }
    }),
    fetchCodexModels: async () => null,
    readClaudeOAuthToken: async () => "tok",
    fetchClaudeUsage: async () => ({ seven_day: { utilization: 12, resets_at: null } })
  };

  it("fetches codex usage via the app-server source as account-level (no pool id)", async () => {
    const pool = normalizeModelPool({ id: "codex-default", toolId: "codex", usageSource: "codex-app-server" });
    const snap = await fetchPoolUsage(codexTool, pool, "/tmp", deps);
    expect(snap).toMatchObject({ toolId: "codex", usedPercent: 50, source: "cli" });
    expect(snap?.modelPoolId).toBeUndefined();
  });

  it("returns null for claude-oauth when no subscription token exists", async () => {
    const pool = normalizeModelPool({ id: "claude-zai", toolId: "claude", usageSource: "claude-oauth" });
    const snap = await fetchPoolUsage(claudeTool, pool, "/tmp", { ...deps, readClaudeOAuthToken: async () => null });
    expect(snap).toBeNull();
  });

  it("returns 'none' source pools as null", async () => {
    const pool = normalizeModelPool({ id: "claude-zai", toolId: "claude", usageSource: "none" });
    expect(await fetchPoolUsage(claudeTool, pool, "/tmp", deps)).toBeNull();
  });

  it("captures provider errors without throwing", async () => {
    const pool = normalizeModelPool({ id: "codex-default", toolId: "codex", usageSource: "codex-app-server" });
    const snap = await fetchPoolUsage(codexTool, pool, "/tmp", {
      ...deps,
      fetchCodexRateLimits: async () => {
        throw new Error("app-server unavailable");
      }
    });
    expect(snap?.error).toContain("app-server unavailable");
  });
});

describe("percent-based capacity", () => {
  it("derives state from usedPercent regardless of policy", () => {
    const snap = { toolId: "codex", used: 0, usedPercent: 97, fetchedAt: "now", source: "cli" as const };
    const status = capacityStatus({ kind: "usage-only", softThresholdPercent: 80 }, snap);
    expect(status.state).toBe("nearing");
    expect(status.remainingFraction).toBeCloseTo(0.03, 2);
    const exhausted = capacityStatus({ kind: "quota", period: "weekly", limit: 100 }, { ...snap, usedPercent: 100 });
    expect(exhausted.state).toBe("exhausted");
  });
});

describe("refreshUsageSnapshots", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-usage-refresh-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records only provider-backed live usage and leaves unsupported tools unavailable", async () => {
    const deps: UsageProviderDeps = {
      fetchCodexRateLimits: async () => ({
        rateLimits: { secondary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 555 } }
      }),
      fetchCodexModels: async () => null,
      readClaudeOAuthToken: async () => null,
      fetchClaudeUsage: async () => ({})
    };
    await refreshUsageSnapshots(root, deps);
    const usage = await loadUsageSnapshots(root);
    const codex = usage.snapshots.find((s) => s.toolId === "codex");
    expect(codex?.usedPercent).toBe(73);
    // Account quota is tool-scoped, not model-scoped.
    expect(codex?.modelPoolId).toBeUndefined();
    // claude has no subscription token → no snapshot.
    expect(usage.snapshots.some((s) => s.toolId === "claude")).toBe(false);
    expect(usage.snapshots.map((s) => s.toolId).sort()).toEqual(["codex"]);
  });

  it("stores one account-level snapshot per tool even when many models share the source", async () => {
    let claudeFetches = 0;
    const deps: UsageProviderDeps = {
      fetchCodexRateLimits: async () => null,
      fetchCodexModels: async () => null,
      readClaudeOAuthToken: async () => "tok",
      fetchClaudeUsage: async () => {
        claudeFetches += 1;
        return { seven_day: { utilization: 41, resets_at: "2026-01-03T00:00:00.000Z" } };
      }
    };
    await refreshUsageSnapshots(root, deps);
    const usage = await loadUsageSnapshots(root);
    const claudeSnaps = usage.snapshots.filter((s) => s.toolId === "claude");
    // Default templates seed several Claude models, all on claude-oauth.
    expect(claudeSnaps).toHaveLength(1);
    expect(claudeSnaps[0]?.modelPoolId).toBeUndefined();
    expect(claudeSnaps[0]?.usedPercent).toBe(41);
    expect(claudeFetches).toBe(1);
  });
});
