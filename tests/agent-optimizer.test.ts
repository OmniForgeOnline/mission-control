import { describe, expect, it } from "vitest";

import { normalizeBundle } from "../src/core/agents/config/normalize.ts";
import {
  formatNoRouteMessage,
  formatPinRouteFailure,
  routeAgent,
  validatePinnedPool,
  type RouteRequest
} from "../src/core/agents/config/optimizer.ts";
import { poolSupportsFeature } from "../src/core/agents/config/pool-features.ts";
import { capacityStatus } from "../src/core/agents/config/usage.ts";
import type { UsageSnapshots } from "../src/core/agents/config/usage.ts";
import type { AgentConfigBundle } from "../src/core/agents/config/types.ts";

function bundle(): AgentConfigBundle {
  return normalizeBundle({
    tools: [
      { id: "claude", command: "claude", adapter: "claude", usage: { kind: "usage-only" } },
      { id: "codex", command: "codex", adapter: "codex", usage: { kind: "quota", period: "weekly", limit: 100 } },
      { id: "kilo", command: "kilo", adapter: "generic", usage: { kind: "usage-only" } }
    ],
    pools: [
      {
        id: "claude-default",
        toolId: "claude",
        capabilities: ["author"],
        tier: "paid",
        modelArgs: ["--model", "claude-sonnet-5"],
        usage: { kind: "usage-only" }
      },
      {
        id: "codex-default",
        toolId: "codex",
        capabilities: ["author"],
        tier: "paid",
        modelArgs: ["--model", "gpt-5"],
        usage: { kind: "quota", period: "weekly", limit: 100 }
      },
      {
        id: "kilo-free",
        toolId: "kilo",
        capabilities: ["author"],
        tier: "free",
        usage: { kind: "usage-only" }
      }
    ],
    profiles: [{ role: "author", requiredCapability: "author" }]
  });
}

function usage(snapshots: UsageSnapshots["snapshots"], refreshedAt?: string): UsageSnapshots {
  return { snapshots, refreshedAt: refreshedAt ?? new Date().toISOString() };
}

describe("routing optimizer", () => {
  it("ranks eligible candidates by tier then pool id", () => {
    const result = routeAgent(bundle(), usage([]), { role: "author" });
    expect(result).toMatchObject({ toolId: "kilo", modelPoolId: "kilo-free", tier: "free" });
    expect(result?.explanation.candidateCount).toBeGreaterThan(0);
  });

  it("falls back past an exhausted pool to the next eligible candidate", () => {
    const exhausted = usage([
      { toolId: "kilo", modelPoolId: "kilo-free", used: 0, fetchedAt: new Date().toISOString(), source: "manual" },
      { toolId: "codex", modelPoolId: "codex-default", used: 100, fetchedAt: new Date().toISOString(), source: "harness" }
    ]);
    const result = routeAgent(bundle(), exhausted, { role: "author" });
    expect(result?.toolId).toBe("kilo");
    expect(result?.explanation.rejected.some((entry) => entry.reason === "quota-exhausted")).toBe(true);
  });

  it("skips disabled tools and unavailable capabilities", () => {
    const result = routeAgent(bundle(), usage([]), { role: "reviewer" });
    expect(result).toBeNull();
  });

  it("honors installedToolIds hard filter", () => {
    const result = routeAgent(bundle(), usage([]), {
      role: "author",
      installedToolIds: new Set(["claude"])
    });
    expect(result?.toolId).toBe("claude");
  });

  it("returns null and a message when every candidate is exhausted", () => {
    const allOut = usage([
      { toolId: "codex", modelPoolId: "codex-default", used: 100, fetchedAt: new Date().toISOString(), source: "harness" }
    ]);
    const onlyCodex = normalizeBundle({
      tools: [{ id: "codex", command: "codex", adapter: "codex", usage: { kind: "quota", period: "weekly", limit: 100 } }],
      pools: [{ id: "codex-default", toolId: "codex", capabilities: ["author"], tier: "paid", usage: { kind: "quota", period: "weekly", limit: 100 } }],
      profiles: [{ role: "author", requiredCapability: "author" }]
    });
    expect(routeAgent(onlyCodex, allOut, { role: "author" })).toBeNull();
    expect(formatNoRouteMessage(onlyCodex, "author")).toContain("No tool/model");
  });
});

describe("routeAgent table-driven scenarios", () => {
  const table: Array<{
    name: string;
    build: () => { bundle: AgentConfigBundle; usage: UsageSnapshots; request: RouteRequest };
    expect: (result: ReturnType<typeof routeAgent>) => void;
  }> = [
    {
      name: "excludes quota-exhausted candidates",
      build: () => ({
        bundle: bundle(),
        usage: usage([
          { toolId: "codex", used: 100, fetchedAt: new Date().toISOString(), source: "harness" }
        ]),
        request: { role: "author", preferredToolId: "codex" }
      }),
      expect: (result) => {
        expect(result?.toolId).not.toBe("codex");
        expect(result?.explanation.rejected.some((entry) => entry.toolId === "codex")).toBe(true);
      }
    },
    {
      name: "filters candidates missing required tool-use feature",
      build: () => {
        const b = normalizeBundle({
          tools: [
            { id: "grok", command: "grok", adapter: "grok", usage: { kind: "usage-only" } },
            { id: "claude", command: "claude", adapter: "claude", usage: { kind: "usage-only" } }
          ],
          pools: [
            {
              id: "grok-default",
              toolId: "grok",
              capabilities: ["author"],
              tier: "paid",
              modelArgs: ["--model", "grok-3"],
              usage: { kind: "usage-only" }
            },
            {
              id: "claude-default",
              toolId: "claude",
              capabilities: ["author"],
              tier: "paid",
              modelArgs: ["--model", "claude-sonnet-5"],
              usage: { kind: "usage-only" }
            }
          ],
          profiles: [{ role: "author", requiredCapability: "author" }]
        });
        return {
          bundle: b,
          usage: usage([]),
          request: { role: "author", requiredFeatures: ["tool-use"] }
        };
      },
      expect: (result) => {
        expect(result?.toolId).toBe("claude");
        expect(result?.explanation.rejected.some((entry) => entry.reason === "missing-feature")).toBe(true);
      }
    },
    {
      name: "treats missing usage data as full headroom",
      build: () => ({
        bundle: bundle(),
        usage: { snapshots: [], refreshedAt: new Date(0).toISOString() },
        request: { role: "author" }
      }),
      expect: (result) => {
        expect(result).not.toBeNull();
        expect(result?.explanation.rankingBasis).toMatch(/stale usage/i);
      }
    },
    {
      name: "breaks ties deterministically by pool id",
      build: () => {
        const b = normalizeBundle({
          tools: [{ id: "claude", command: "claude", adapter: "claude", usage: { kind: "usage-only" } }],
          pools: [
            {
              id: "claude-b",
              toolId: "claude",
              capabilities: ["author"],
              tier: "paid",
              modelArgs: ["--model", "claude-sonnet-5"],
              usage: { kind: "usage-only" }
            },
            {
              id: "claude-a",
              toolId: "claude",
              capabilities: ["author"],
              tier: "paid",
              modelArgs: ["--model", "claude-sonnet-4-5"],
              usage: { kind: "usage-only" }
            }
          ],
          profiles: [{ role: "author", requiredCapability: "author" }]
        });
        return { bundle: b, usage: usage([]), request: { role: "author" } };
      },
      expect: (result) => {
        expect(result?.modelPoolId).toBe("claude-a");
        const repeat = routeAgent(
          normalizeBundle({
            tools: [{ id: "claude", command: "claude", adapter: "claude", usage: { kind: "usage-only" } }],
            pools: [
              {
                id: "claude-b",
                toolId: "claude",
                capabilities: ["author"],
                tier: "paid",
                modelArgs: ["--model", "claude-sonnet-5"],
                usage: { kind: "usage-only" }
              },
              {
                id: "claude-a",
                toolId: "claude",
                capabilities: ["author"],
                tier: "paid",
                modelArgs: ["--model", "claude-sonnet-4-5"],
                usage: { kind: "usage-only" }
              }
            ],
            profiles: [{ role: "author", requiredCapability: "author" }]
          }),
          usage([]),
          { role: "author" }
        );
        expect(repeat?.modelPoolId).toBe("claude-a");
      }
    }
  ];

  for (const scenario of table) {
    it(scenario.name, () => {
      const { bundle: b, usage: u, request } = scenario.build();
      scenario.expect(routeAgent(b, u, request));
    });
  }
});

describe("explicit pin validation", () => {
  it("accepts a valid pin and rejects exhausted pins with a clear reason", () => {
    const b = bundle();
    const request: RouteRequest = { role: "author" };
    const ok = validatePinnedPool(b, usage([]), request, "claude", "claude-default");
    expect(ok.ok).toBe(true);

    const exhausted = usage([
      { toolId: "codex", used: 100, fetchedAt: new Date().toISOString(), source: "harness" }
    ]);
    const bad = validatePinnedPool(b, exhausted, request, "codex", "codex-default");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(formatPinRouteFailure("codex", "codex-default", bad)).toMatch(/cannot run/i);
    }
  });

  it("rejects pins on the wrong tool without silent identity switch", () => {
    const b = bundle();
    const bad = validatePinnedPool(b, usage([]), { role: "author" }, "codex", "claude-default");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.detail).toMatch(/belongs to "claude"/);
    }
  });
});

describe("pool feature support", () => {
  it("maps tool-use to streamTools adapters", () => {
    const b = bundle();
    const claudeTool = b.tools.find((tool) => tool.id === "claude")!;
    const claudePool = b.pools.find((pool) => pool.id === "claude-default")!;
    expect(poolSupportsFeature(claudeTool, claudePool, "tool-use")).toBe(true);
  });
});

describe("capacity status", () => {
  it("treats capless 'unavailable' policy as unknown with full headroom", () => {
    const status = capacityStatus({ kind: "unavailable" });
    expect(status.state).toBe("unknown");
    expect(status.remainingFraction).toBe(1);
    expect(status.limit).toBeUndefined();
  });

  it("treats usage-only policy as available regardless of spend", () => {
    const status = capacityStatus(
      { kind: "usage-only", softThresholdPercent: 80 },
      { toolId: "claude", used: 9999, fetchedAt: new Date().toISOString(), source: "harness" }
    );
    expect(status.state).toBe("available");
  });

  it("flags quota nearing and exhausted states", () => {
    const nearing = capacityStatus(
      { kind: "quota", period: "weekly", limit: 100, softThresholdPercent: 80 },
      { toolId: "codex", used: 85, fetchedAt: new Date().toISOString(), source: "harness" }
    );
    expect(nearing.state).toBe("nearing");
    const exhausted = capacityStatus(
      { kind: "quota", period: "weekly", limit: 100, softThresholdPercent: 80 },
      { toolId: "codex", used: 100, fetchedAt: new Date().toISOString(), source: "harness" }
    );
    expect(exhausted.state).toBe("exhausted");
  });
});
