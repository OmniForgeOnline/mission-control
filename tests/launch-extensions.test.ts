import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { writeClaudeExtensionConfig } from "../src/core/agents/extensions/inject-claude.ts";
import {
  buildCodexExtensionOverrides,
  codexOverridesToCliArgs
} from "../src/core/agents/extensions/inject-codex.ts";
import { writeLaunchExtensions } from "../src/mcp/launcher.ts";
import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";

describe("launch extension injection", () => {
  let root: string;
  let worktree: string;
  let runDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-launch-ext-"));
    await ensureHarnessRepository(root);
    worktree = path.join(root, "worktree");
    runDir = path.join(root, "data", "runs", "run-1");
    await mkdir(worktree, { recursive: true });
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes Claude settings.local.json under cwd only", async () => {
    const entries = [
      {
        id: "claude:plugin:a@m",
        toolId: "claude" as const,
        kind: "plugin" as const,
        displayName: "a",
        source: "a@m",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      },
      {
        id: "claude:plugin:b@m",
        toolId: "claude" as const,
        kind: "plugin" as const,
        displayName: "b",
        source: "b@m",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      }
    ];

    const result = await writeClaudeExtensionConfig({
      cwd: worktree,
      allPlugins: entries,
      enabledIds: ["claude:plugin:a@m"]
    });

    expect(result.settingsLocalPath).toBe(path.join(worktree, ".claude", "settings.local.json"));
    const payload = JSON.parse(await readFile(result.settingsLocalPath, "utf8"));
    expect(payload.enabledPlugins).toEqual({ "a@m": true, "b@m": false });
  });

  it("appends Codex -c overrides for plugins and skills", async () => {
    const entries = [
      {
        id: "codex:plugin:demo",
        toolId: "codex" as const,
        kind: "plugin" as const,
        displayName: "demo",
        source: "demo",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      },
      {
        id: "codex:skill:lint",
        toolId: "codex" as const,
        kind: "skill" as const,
        displayName: "lint",
        source: "/skills/lint",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      }
    ];
    const args = codexOverridesToCliArgs(buildCodexExtensionOverrides(entries, ["codex:plugin:demo"]));
    expect(args).toContain("-c");
    expect(args.join(" ")).toContain("plugins.demo.enabled=true");
    expect(args.join(" ")).toContain("skills.config=");
  });

  it("writeLaunchExtensions keeps MCP config in run dir and Claude extensions in worktree", async () => {
    const claudeTool = builtinAgentConfigBundle().tools.find((tool) => tool.adapter === "claude")!;
    const entries = [
      {
        id: "claude:plugin:demo@m",
        toolId: "claude" as const,
        kind: "plugin" as const,
        displayName: "demo",
        source: "demo@m",
        detectedFrom: "disk" as const,
        defaultEnabled: true
      }
    ];

    const result = await writeLaunchExtensions({
      tool: claudeTool,
      harnessRoot: root,
      runId: "run-1",
      runDir,
      cwd: worktree,
      extensions: entries,
      enabledExtensionIds: []
    });

    expect(result.configPath).toBe(path.join(runDir, "mcp-config.json"));
    expect(result.extensionConfigPath).toBe(path.join(worktree, ".claude", "settings.local.json"));
    expect(result.cliArgs[0]).toBe("--mcp-config");
  });
});
