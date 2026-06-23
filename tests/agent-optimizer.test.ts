import { describe, expect, it } from "vitest";

import { normalizeBundle } from "../src/core/agents/config/normalize.ts";
import { routeAgent, formatNoRouteMessage } from "../src/core/agents/config/optimizer.ts";
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
        qualityWeight: 90,
        tier: "paid",
        usage: { kind: "usage-only" }
      },
      {
        id: "codex-default",
        toolId: "codex",
        capabilities: ["author"],
        qualityWeight: 85,
        tier: "paid",
        usage: { kind: "quota", period: "weekly", limit: 100 }
      },
      {
        id: "kilo-free",
        toolId: "kilo",
        capabilities: ["author"],
        qualityWeight: 80,
        tier: "free",
        usage: { kind: "usage-only" }
      }
    ],
    profiles: [{ role: "author", requiredCapability: "author", minQuality: 0 }]
  });
}

function usage(snapshots: UsageSnapshots["snapshots"]): UsageSnapshots {
  return { snapshots, refreshedAt: new Date().toISOString() };
}

describe("routing optimizer", () => {
  it("prefers the highest-quality pool within the band, breaking ties toward free tier", () => {
    // claude(90), codex(85), kilo(80 free) all within the 15-point band → free wins.
    const result = routeAgent(bundle(), usage([]), { role: "author" });
    expect(result).toMatchObject({ toolId: "kilo", modelPoolId: "kilo-free", tier: "free" });
  });

  it("excludes low-quality pools outside the acceptable band", () => {
    const narrow = normalizeBundle({
      tools: [
        { id: "claude", command: "claude", adapter: "claude", usage: { kind: "usage-only" } },
        { id: "kilo", command: "kilo", adapter: "generic", usage: { kind: "usage-only" } }
      ],
      pools: [
        { id: "claude-default", toolId: "claude", capabilities: ["author"], qualityWeight: 95, tier: "paid", usage: { kind: "usage-only" } },
        { id: "kilo-free", toolId: "kilo", capabilities: ["author"], qualityWeight: 50, tier: "free", usage: { kind: "usage-only" } }
      ],
      profiles: [{ role: "author", minQuality: 0 }]
    });
    // kilo(50) is far below claude(95) → outside the band, so paid high-quality wins.
    const result = routeAgent(narrow, usage([]), { role: "author" });
    expect(result?.toolId).toBe("claude");
  });

  it("falls back past an exhausted preferred pool", () => {
    const exhausted = usage([
      { toolId: "kilo", modelPoolId: "kilo-free", used: 0, fetchedAt: new Date().toISOString(), source: "manual" },
      { toolId: "codex", modelPoolId: "codex-default", used: 100, fetchedAt: new Date().toISOString(), source: "harness" }
    ]);
    // codex pool is at its quota limit → excluded; free kilo still wins the band.
    const result = routeAgent(bundle(), exhausted, { role: "author" });
    expect(result?.toolId).toBe("kilo");
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
      pools: [{ id: "codex-default", toolId: "codex", capabilities: ["author"], qualityWeight: 85, tier: "paid", usage: { kind: "quota", period: "weekly", limit: 100 } }],
      profiles: [{ role: "author", minQuality: 0 }]
    });
    expect(routeAgent(onlyCodex, allOut, { role: "author" })).toBeNull();
    expect(formatNoRouteMessage(onlyCodex, "author")).toContain("No tool/model");
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
