import { describe, expect, it } from "vitest";

import {
  extensionIdForInstalledPlugin,
  parsePluginSource,
  validateMarketplaceSource
} from "../src/core/agents/extensions/install.ts";

describe("extension install helpers", () => {
  it("parses plugin@marketplace source", () => {
    expect(parsePluginSource("claude-seo@claude-plugins-official")).toEqual({
      plugin: "claude-seo",
      marketplace: "claude-plugins-official",
      selector: "claude-seo@claude-plugins-official"
    });
  });

  it("accepts separate plugin and marketplace fields", () => {
    expect(parsePluginSource("claude-seo", "claude-plugins-official")).toEqual({
      plugin: "claude-seo",
      marketplace: "claude-plugins-official",
      selector: "claude-seo@claude-plugins-official"
    });
  });

  it("rejects malformed plugin source", () => {
    expect(() => parsePluginSource("")).toThrow(/required/i);
    expect(() => parsePluginSource("plugin-only")).toThrow(/marketplace/i);
  });

  it("validates marketplace source characters", () => {
    expect(() => validateMarketplaceSource("anthropics/claude-plugins-official")).not.toThrow();
    expect(() => validateMarketplaceSource("bad;source")).toThrow(/invalid/i);
  });

  it("builds stable extension ids per tool", () => {
    expect(extensionIdForInstalledPlugin("claude", "demo@market")).toBe("claude:plugin:demo@market");
    expect(extensionIdForInstalledPlugin("codex", "demo@market")).toBe("codex:plugin:demo");
  });
});
