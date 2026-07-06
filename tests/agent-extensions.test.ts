import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { discoverClaudeExtensions } from "../src/core/agents/extensions/discover-claude.ts";
import { discoverCodexExtensions, parseCodexConfigToml } from "../src/core/agents/extensions/discover-codex.ts";
import { mergeRegistryWithDiscovery, resolveExtensionsForLaunch } from "../src/core/agents/extensions/resolve.ts";
import {
  loadExtensionRegistry,
  replaceDiscoveredExtensions,
  upsertExtension
} from "../src/core/agents/extensions/store.ts";

describe("agent extensions", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-agent-ext-"));
    home = path.join(root, "home");
    await ensureHarnessRepository(root);
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("discovers Claude plugins from settings.json", async () => {
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "demo@marketplace": true } }),
      "utf8"
    );
    const discovered = await discoverClaudeExtensions({ homeDir: home });
    expect(discovered.some((entry) => entry.source === "demo@marketplace")).toBe(true);
  });

  it("parses Codex config.toml plugins and skills.config", async () => {
    const parsed = parseCodexConfigToml(`
[plugins.demo]
enabled = false

[[skills.config]]
path = "/path/to/skill"
enabled = true
`);
    expect(parsed.plugins["demo"]?.enabled).toBe(false);
    expect(parsed.skills[0]?.path).toBe("/path/to/skill");
  });

  it("parses quoted Codex plugin section names", async () => {
    const parsed = parseCodexConfigToml(`
[plugins."github@openai-curated"]
enabled = true
`);
    expect(parsed.plugins["github@openai-curated"]?.enabled).toBe(true);
  });

  it("discovers Claude plugins from installed_plugins.json", async () => {
    await mkdir(path.join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "claude-seo@agricidaniel-claude-seo": [{}] } }),
      "utf8"
    );
    const discovered = await discoverClaudeExtensions({ homeDir: home });
    expect(discovered.some((entry) => entry.source === "claude-seo@agricidaniel-claude-seo")).toBe(true);
  });

  it("discovers quoted Codex plugins from config.toml on disk", async () => {
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      `[plugins."demo@marketplace"]\nenabled = true\n`,
      "utf8"
    );
    const discovered = await discoverCodexExtensions({ homeDir: home });
    expect(discovered.some((entry) => entry.id === "codex:plugin:demo@marketplace")).toBe(true);
  });

  it("discovers Codex plugins from config.toml on disk", async () => {
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      `[plugins.demo]\nenabled = true\n`,
      "utf8"
    );
    const discovered = await discoverCodexExtensions({ homeDir: home });
    expect(discovered.some((entry) => entry.id === "codex:plugin:demo")).toBe(true);
  });

  it("merges discovery into registry preserving defaultEnabled overrides", async () => {
    await upsertExtension(root, {
      id: "claude:plugin:demo@market",
      toolId: "claude",
      kind: "plugin",
      displayName: "Demo",
      source: "demo@market",
      detectedFrom: "disk",
      defaultEnabled: false
    });

    const merged = mergeRegistryWithDiscovery(
      (await loadExtensionRegistry(root)).extensions,
      [
        {
          id: "claude:plugin:demo@market",
          toolId: "claude",
          kind: "plugin",
          displayName: "demo",
          source: "demo@market",
          installed: true
        }
      ]
    );
    expect(merged.find((entry) => entry.id === "claude:plugin:demo@market")?.defaultEnabled).toBe(false);
  });

  it("replaceDiscoveredExtensions preserves manual entries", async () => {
    await upsertExtension(root, {
      id: "manual:plugin",
      toolId: "claude",
      kind: "plugin",
      displayName: "Manual",
      source: "manual@market",
      detectedFrom: "manual",
      defaultEnabled: true
    });

    const registry = await replaceDiscoveredExtensions(
      root,
      [
        {
          id: "claude:plugin:found",
          toolId: "claude",
          kind: "plugin",
          displayName: "Found",
          source: "found@market",
          detectedFrom: "disk",
          defaultEnabled: true
        }
      ],
      new Date().toISOString()
    );

    expect(registry.extensions.some((entry) => entry.id === "manual:plugin")).toBe(true);
    expect(registry.extensions.some((entry) => entry.id === "claude:plugin:found")).toBe(true);
  });

  it("resolveExtensionsForLaunch falls back to empty when nothing default-enabled", () => {
    const resolved = resolveExtensionsForLaunch({
      toolId: "claude",
      registry: [
        {
          id: "claude:plugin:demo",
          toolId: "claude",
          kind: "plugin",
          displayName: "demo",
          source: "demo@market",
          detectedFrom: "disk",
          defaultEnabled: false
        }
      ],
      discovered: []
    });
    expect(resolved.enabledIds).toEqual([]);
  });
});
