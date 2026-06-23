import { describe, expect, it } from "vitest";

import { agentVisual, effortBarSpec } from "../src/ui/features/tasks/detail/workflow/panel/step-setting-visual.ts";

describe("agentVisual", () => {
  it("returns brand colors for known agents", () => {
    expect(agentVisual("codex")).toEqual({ color: "#10a37f", initial: "C" });
    expect(agentVisual("claude")).toEqual({ color: "#d97757", initial: "C" });
    expect(agentVisual("grok")).toEqual({ color: "#1d9bf0", initial: "G" });
    expect(agentVisual("opencode")).toEqual({ color: "var(--accent)", initial: "O" });
  });

  it("derives a neutral swatch + initial for unknown agents", () => {
    expect(agentVisual("mystery", "Mystery Bot")).toEqual({
      color: "var(--ink-faint)",
      initial: "M"
    });
  });

  it("falls back to the id when no display name is given", () => {
    expect(agentVisual("zeta")).toEqual({ color: "var(--ink-faint)", initial: "Z" });
  });

  it("handles empty/nullish input without throwing", () => {
    expect(agentVisual(null)).toEqual({ color: "var(--ink-faint)", initial: "·" });
    expect(agentVisual(undefined, "")).toEqual({ color: "var(--ink-faint)", initial: "·" });
  });
});

describe("effortBarSpec", () => {
  it("lights bars up to and including the selected level", () => {
    const bars = effortBarSpec(["low", "medium", "high"], "medium");
    expect(bars.map((b) => b.on)).toEqual([true, true, false]);
  });

  it("lights all bars at the top level and ramps heights", () => {
    const bars = effortBarSpec(["low", "medium", "high"], "high");
    expect(bars.map((b) => b.on)).toEqual([true, true, true]);
    expect(bars.map((b) => b.height)).toEqual([5, 9, 13]);
  });

  it("lights none for an unknown or empty selection", () => {
    expect(effortBarSpec(["low", "medium", "high"], "").every((b) => !b.on)).toBe(true);
    expect(effortBarSpec(["low", "medium", "high"], "extreme").every((b) => !b.on)).toBe(true);
  });

  it("adapts bar count to the agent's effort levels", () => {
    const bars = effortBarSpec(["minimal", "low", "medium", "high"], "low");
    expect(bars).toHaveLength(4);
    expect(bars.map((b) => b.on)).toEqual([true, true, false, false]);
    expect(bars[0]?.height).toBe(5);
    expect(bars[3]?.height).toBe(13);
  });
});
