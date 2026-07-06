import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveCommandBinary } from "../resolver.ts";
import { loadAgentConfig } from "../config/store.ts";
import type { ToolId } from "../../types.ts";

const exec = promisify(execFile);

export interface InstallPluginRequest {
  toolId: ToolId;
  /** plugin@marketplace, or plugin with marketplace field. */
  source: string;
  marketplace?: string;
  /** Optional marketplace to register first (owner/repo, git URL, or local path). */
  marketplaceSource?: string;
}

export interface InstallPluginResult {
  command: string;
  stdout: string;
  plugin: string;
  marketplace: string;
  selector: string;
}

const MARKETPLACE_SOURCE_PATTERN = /^[\w./:@-]+$/;

export function parsePluginSource(
  source: string,
  marketplace?: string
): { plugin: string; marketplace: string; selector: string } {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("Plugin source is required.");
  }
  if (trimmed.includes("@")) {
    const at = trimmed.lastIndexOf("@");
    const plugin = trimmed.slice(0, at).trim();
    const market = trimmed.slice(at + 1).trim();
    if (!plugin || !market) {
      throw new Error('Use the format "plugin@marketplace".');
    }
    return { plugin, marketplace: market, selector: `${plugin}@${market}` };
  }
  const market = marketplace?.trim();
  if (!market) {
    throw new Error('Plugin source must be "plugin@marketplace" or include a marketplace field.');
  }
  return { plugin: trimmed, marketplace: market, selector: `${trimmed}@${market}` };
}

export function validateMarketplaceSource(source: string): void {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 512) {
    throw new Error("Marketplace source must be under 512 characters.");
  }
  if (!MARKETPLACE_SOURCE_PATTERN.test(trimmed)) {
    throw new Error("Marketplace source contains invalid characters.");
  }
}

export function extensionIdForInstalledPlugin(toolId: ToolId, selector: string): string {
  if (toolId === "codex") {
    const plugin = selector.includes("@") ? selector.slice(0, selector.lastIndexOf("@")) : selector;
    return `codex:plugin:${plugin}`;
  }
  return `claude:plugin:${selector}`;
}

export async function installMarketplacePlugin(
  harnessRoot: string,
  request: InstallPluginRequest
): Promise<InstallPluginResult> {
  const bundle = await loadAgentConfig(harnessRoot);
  const tool = bundle.tools.find((entry) => entry.id === request.toolId);
  if (!tool) {
    throw new Error(`Unknown tool "${request.toolId}".`);
  }
  if (tool.adapter !== "claude" && tool.adapter !== "codex") {
    throw new Error("Marketplace install is supported for Claude Code and Codex only.");
  }

  const parsed = parsePluginSource(request.source, request.marketplace);
  const binary = resolveCommandBinary(tool.command, harnessRoot);

  if (request.marketplaceSource?.trim()) {
    validateMarketplaceSource(request.marketplaceSource);
    const addArgs = ["plugin", "marketplace", "add", request.marketplaceSource.trim()];
    await exec(binary, addArgs, {
      cwd: harnessRoot,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
  }

  const installArgs =
    tool.adapter === "claude"
      ? ["plugin", "install", parsed.selector, "--scope", "user"]
      : ["plugin", "add", parsed.selector];

  const { stdout } = await exec(binary, installArgs, {
    cwd: harnessRoot,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  });

  return {
    command: [binary, ...installArgs].join(" "),
    stdout: stdout.trim(),
    plugin: parsed.plugin,
    marketplace: parsed.marketplace,
    selector: parsed.selector
  };
}
