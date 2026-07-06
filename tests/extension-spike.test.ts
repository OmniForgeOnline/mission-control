import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { discoverClaudeExtensions } from "../src/core/agents/extensions/discover-claude.ts";
import { parseCodexConfigToml } from "../src/core/agents/extensions/discover-codex.ts";
import { buildClaudeEnabledPlugins, writeClaudeExtensionConfig } from "../src/core/agents/extensions/inject-claude.ts";
import {
  buildCodexExtensionOverrides,
  codexOverridesToCliArgs
} from "../src/core/agents/extensions/inject-codex.ts";
import { resolveExtensionsForLaunch } from "../src/core/agents/extensions/resolve.ts";
import { writeLaunchExtensions } from "../src/mcp/launcher.ts";
import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";

describe("extension spike — launch mechanisms", () => {
  let root: string;
  let home: string;

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function setup(): Promise<void> {
    root = await mkdtemp(path.join(tmpdir(), "harness-ext-spike-"));
    home = path.join(root, "home");
    await ensureHarnessRepository(root);
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
  }

  it("Claude worktree settings.local.json scopes enabledPlugins without touching home config", async () => {
    await setup();
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "claude-seo@marketplace": true, "other@marketplace": true } }),
      "utf8"
    );

    const discovered = await discoverClaudeExtensions({ homeDir: home, projectDir: root });
    const plugins = discovered.filter((entry) => entry.kind === "plugin");
    expect(plugins.map((entry) => entry.source)).toEqual(
      expect.arrayContaining(["claude-seo@marketplace", "other@marketplace"])
    );

    const entries = plugins.map((entry) => ({
      id: entry.id,
      toolId: "claude" as const,
      kind: "plugin" as const,
      displayName: entry.displayName,
      source: entry.source,
      detectedFrom: "disk" as const,
      defaultEnabled: false
    }));

    const enabledMap = buildClaudeEnabledPlugins(entries, [entries[0]!.id]);
    expect(enabledMap["claude-seo@marketplace"]).toBe(true);
    expect(enabledMap["other@marketplace"]).toBe(false);

    const worktree = path.join(root, "worktree");
    await mkdir(worktree, { recursive: true });
    const launch = await writeClaudeExtensionConfig({
      cwd: worktree,
      allPlugins: entries,
      enabledIds: [entries[0]!.id]
    });

    expect(launch.settingsLocalPath).toBe(path.join(worktree, ".claude", "settings.local.json"));
    expect(launch.settingsLocalPath.startsWith(root)).toBe(true);
    expect(launch.settingsLocalPath.includes(home)).toBe(false);

    const written = JSON.parse(await readFile(launch.settingsLocalPath, "utf8"));
    expect(written.enabledPlugins["claude-seo@marketplace"]).toBe(true);
    expect(written.enabledPlugins["other@marketplace"]).toBe(false);

    const homeSettings = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(homeSettings.enabledPlugins["other@marketplace"]).toBe(true);
  });

  it("Codex -c overrides express plugin and skill enablement", async () => {
    await setup();
    const toml = `
[plugins.claude-seo]
enabled = true

[[skills.config]]
path = "/skills/seo"
enabled = true
`;
    expect(parseCodexConfigToml(toml).plugins["claude-seo"]?.enabled).toBe(true);

    const entries = [
      {
        id: "codex:plugin:claude-seo",
        toolId: "codex" as const,
        kind: "plugin" as const,
        displayName: "claude-seo",
        source: "claude-seo",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      },
      {
        id: "codex:skill:seo",
        toolId: "codex" as const,
        kind: "skill" as const,
        displayName: "seo",
        source: "/skills/seo",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      }
    ];

    const overrides = buildCodexExtensionOverrides(entries, ["codex:plugin:claude-seo"]);
    const cliArgs = codexOverridesToCliArgs(overrides);
    expect(cliArgs.join(" ")).toContain("plugins.claude-seo.enabled=true");
    expect(cliArgs.join(" ")).toContain("skills.config=");
    expect(cliArgs.join(" ")).toContain("enabled = false");
  });

  it("writeLaunchExtensions writes only under worktree and run dir", async () => {
    await setup();
    const worktree = path.join(root, "worktree");
    await mkdir(worktree, { recursive: true });
    const runDir = path.join(root, "data", "runs", "run-ext");
    await mkdir(runDir, { recursive: true });

    const claudeTool = builtinAgentConfigBundle().tools.find((tool) => tool.adapter === "claude")!;
    const entries = [
      {
        id: "claude:plugin:demo@market",
        toolId: "claude" as const,
        kind: "plugin" as const,
        displayName: "demo",
        source: "demo@market",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      }
    ];

    const result = await writeLaunchExtensions({
      tool: claudeTool,
      harnessRoot: root,
      runId: "run-ext",
      runDir,
      cwd: worktree,
      extensions: entries,
      enabledExtensionIds: entries.map((entry) => entry.id)
    });

    expect(result.configPath?.startsWith(runDir)).toBe(true);
    expect(result.extensionConfigPath?.startsWith(worktree)).toBe(true);
    expect(result.extensionConfigPath?.includes(home)).toBe(false);
  });

  it("documents grok global mcp add anti-pattern — launch scoping deferred", async () => {
    await setup();
    const { ensureGrokMcp } = await import("../src/mcp/launcher-gbrain.ts");
    expect(typeof ensureGrokMcp).toBe("function");
    expect(String(ensureGrokMcp)).toContain('"add"');
  });
});

describe("extension resolution precedence", () => {
  it("prefers step extensions over registry defaults", () => {
    const registry = [
      {
        id: "claude:plugin:seo",
        toolId: "claude" as const,
        kind: "plugin" as const,
        displayName: "seo",
        source: "seo@market",
        detectedFrom: "disk" as const,
        defaultEnabled: false
      },
      {
        id: "claude:plugin:other",
        toolId: "claude" as const,
        kind: "plugin" as const,
        displayName: "other",
        source: "other@market",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      }
    ];

    const stepResolved = resolveExtensionsForLaunch({
      toolId: "claude",
      registry,
      discovered: [],
      stepExtensionIds: ["claude:plugin:seo"]
    });
    expect(stepResolved.enabledIds).toEqual(["claude:plugin:seo"]);

    const defaultResolved = resolveExtensionsForLaunch({
      toolId: "claude",
      registry,
      discovered: []
    });
    expect(defaultResolved.enabledIds).toEqual(["claude:plugin:other"]);
  });
});
