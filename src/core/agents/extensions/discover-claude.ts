import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ToolId } from "../../types.ts";
import type { DiscoveredExtension, DiscoverRoots } from "./types.ts";

const TOOL_ID: ToolId = "claude";

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
}

async function readJsonSafe(filePath: string): Promise<ClaudeSettings | null> {
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return null;
  }
}

async function discoverSkillsFromDir(
  dir: string,
  prefix: string
): Promise<DiscoveredExtension[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: DiscoveredExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const id = `${prefix}skill:${entry.name}`;
    out.push({
      id,
      toolId: TOOL_ID,
      kind: "skill",
      displayName: entry.name,
      source: skillFile,
      installed: true
    });
  }
  return out;
}

function mergeEnabledPlugins(
  ...settings: Array<ClaudeSettings | null>
): Record<string, boolean> {
  const merged: Record<string, boolean> = {};
  for (const setting of settings) {
    if (!setting?.enabledPlugins) continue;
    for (const [key, value] of Object.entries(setting.enabledPlugins)) {
      merged[key] = value;
    }
  }
  return merged;
}

interface ClaudeInstalledPlugins {
  plugins?: Record<string, unknown[]>;
}

async function discoverClaudeInstalledPlugins(
  homeDir: string,
  enabledPlugins: Record<string, boolean>
): Promise<DiscoveredExtension[]> {
  const installedPath = path.join(homeDir, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(installedPath)) return [];

  try {
    const raw = await readFile(installedPath, "utf8");
    const parsed = JSON.parse(raw) as ClaudeInstalledPlugins;
    const discovered: DiscoveredExtension[] = [];
    for (const pluginKey of Object.keys(parsed.plugins ?? {})) {
      const enabled = enabledPlugins[pluginKey];
      discovered.push({
        id: `claude:plugin:${pluginKey}`,
        toolId: TOOL_ID,
        kind: "plugin",
        displayName: pluginKey.split("@")[0] ?? pluginKey,
        source: pluginKey,
        installed: enabled !== false
      });
    }
    return discovered;
  } catch {
    return [];
  }
}

function upsertClaudePlugin(
  discovered: DiscoveredExtension[],
  pluginKey: string,
  enabled: boolean
): void {
  const id = `claude:plugin:${pluginKey}`;
  const existing = discovered.find((item) => item.id === id);
  if (existing) {
    existing.installed = enabled !== false;
    return;
  }
  discovered.push({
    id,
    toolId: TOOL_ID,
    kind: "plugin",
    displayName: pluginKey.split("@")[0] ?? pluginKey,
    source: pluginKey,
    installed: enabled !== false
  });
}

async function discoverClaudePluginsFromCache(homeDir: string): Promise<DiscoveredExtension[]> {
  const cacheRoot = path.join(homeDir, ".claude", "plugins", "cache");
  if (!existsSync(cacheRoot)) return [];

  const discovered: DiscoveredExtension[] = [];
  const marketplaces = await readdir(cacheRoot, { withFileTypes: true });
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue;
    const marketplacePath = path.join(cacheRoot, marketplace.name);
    const plugins = await readdir(marketplacePath, { withFileTypes: true });
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const selector = `${plugin.name}@${marketplace.name}`;
      discovered.push({
        id: `claude:plugin:${selector}`,
        toolId: TOOL_ID,
        kind: "plugin",
        displayName: plugin.name,
        source: selector,
        installed: true
      });
    }
  }
  return discovered;
}

/** Discover Claude Code plugins and skills from user + optional project config. */
export async function discoverClaudeExtensions(roots: DiscoverRoots): Promise<DiscoveredExtension[]> {
  const userSettings = await readJsonSafe(path.join(roots.homeDir, ".claude", "settings.json"));
  const projectSettings = roots.projectDir
    ? await readJsonSafe(path.join(roots.projectDir, ".claude", "settings.json"))
    : null;
  const localSettings = roots.projectDir
    ? await readJsonSafe(path.join(roots.projectDir, ".claude", "settings.local.json"))
    : null;

  const enabledPlugins = mergeEnabledPlugins(userSettings, projectSettings, localSettings);
  const discovered: DiscoveredExtension[] = [];

  discovered.push(...(await discoverClaudeInstalledPlugins(roots.homeDir, enabledPlugins)));
  discovered.push(...(await discoverClaudePluginsFromCache(roots.homeDir)));

  for (const [pluginKey, enabled] of Object.entries(enabledPlugins)) {
    upsertClaudePlugin(discovered, pluginKey, enabled);
  }

  const skillDirs = [
    path.join(roots.homeDir, ".claude", "skills"),
    ...(roots.projectDir ? [path.join(roots.projectDir, ".claude", "skills")] : [])
  ];
  for (const dir of skillDirs) {
    const prefix = dir.includes(roots.homeDir) ? "claude:user:" : "claude:project:";
    discovered.push(...(await discoverSkillsFromDir(dir, prefix)));
  }

  return dedupeById(discovered);
}

function dedupeById(items: Array<DiscoveredExtension>): Array<DiscoveredExtension> {
  const seen = new Map<string, DiscoveredExtension>();
  for (const item of items) {
    seen.set(item.id, item);
  }
  return [...seen.values()];
}
