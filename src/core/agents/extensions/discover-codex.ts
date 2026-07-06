import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ToolId } from "../../types.ts";
import type { DiscoveredExtension, DiscoverRoots } from "./types.ts";

const TOOL_ID: ToolId = "codex";

interface CodexSkillEntry {
  path: string;
  enabled: boolean;
}

/** Minimal TOML reader for Codex plugins and skills.config sections. */
export function parseCodexConfigToml(content: string): {
  plugins: Record<string, { enabled?: boolean }>;
  skills: CodexSkillEntry[];
} {
  const plugins: Record<string, { enabled?: boolean }> = {};
  const skills: CodexSkillEntry[] = [];

  const lines = content.split(/\r?\n/);
  let inSkillsConfig = false;
  let currentPlugin: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const pluginMatch = line.match(/^\[plugins\.(?:"([^"]+)"|([^\]]+))\]$/);
    if (pluginMatch) {
      currentPlugin = pluginMatch[1] ?? pluginMatch[2] ?? null;
      if (currentPlugin) {
        plugins[currentPlugin] = plugins[currentPlugin] ?? {};
      }
      inSkillsConfig = false;
      continue;
    }

    if (line === "[[skills.config]]") {
      inSkillsConfig = true;
      skills.push({ path: "", enabled: true });
      currentPlugin = null;
      continue;
    }

    if (line.startsWith("[") && !line.startsWith("[[skills.config]]")) {
      inSkillsConfig = false;
      currentPlugin = null;
    }

    const kv = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = parseTomlValue(kv[2]!.trim());

    if (inSkillsConfig && skills.length > 0) {
      const entry = skills[skills.length - 1]!;
      if (key === "path" && typeof value === "string") entry.path = value;
      if (key === "enabled" && typeof value === "boolean") entry.enabled = value;
      continue;
    }

    if (currentPlugin && key === "enabled" && typeof value === "boolean") {
      plugins[currentPlugin]!.enabled = value;
    }
  }

  return { plugins, skills };
}

function parseTomlValue(raw: string): string | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

async function readTomlSafe(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function discoverCodexSkillsFromDir(dir: string, prefix: string): Promise<DiscoveredExtension[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: DiscoveredExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    out.push({
      id: `${prefix}skill:${entry.name}`,
      toolId: TOOL_ID,
      kind: "skill",
      displayName: entry.name,
      source: skillFile,
      installed: true
    });
  }
  return out;
}

async function discoverCodexPluginsFromCache(homeDir: string): Promise<DiscoveredExtension[]> {
  const cacheRoot = path.join(homeDir, ".codex", "plugins", "cache");
  if (!existsSync(cacheRoot)) return [];

  const discovered: DiscoveredExtension[] = [];
  const marketplaces = await readdir(cacheRoot, { withFileTypes: true });
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory() || marketplace.name.startsWith(".")) continue;
    const marketplacePath = path.join(cacheRoot, marketplace.name);
    const plugins = await readdir(marketplacePath, { withFileTypes: true });
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const selector = `${plugin.name}@${marketplace.name}`;
      discovered.push({
        id: `codex:plugin:${selector}`,
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

/** Discover Codex plugins and skills from user + optional project config. */
export async function discoverCodexExtensions(roots: DiscoverRoots): Promise<DiscoveredExtension[]> {
  const configPaths = [
    path.join(roots.homeDir, ".codex", "config.toml"),
    ...(roots.projectDir ? [path.join(roots.projectDir, ".codex", "config.toml")] : [])
  ];

  const plugins: Record<string, { enabled?: boolean }> = {};
  const skills: CodexSkillEntry[] = [];

  for (const configPath of configPaths) {
    const content = await readTomlSafe(configPath);
    if (!content) continue;
    const parsed = parseCodexConfigToml(content);
    Object.assign(plugins, parsed.plugins);
    skills.push(...parsed.skills);
  }

  const discovered: DiscoveredExtension[] = [];

  discovered.push(...(await discoverCodexPluginsFromCache(roots.homeDir)));

  for (const [pluginId, meta] of Object.entries(plugins)) {
    discovered.push({
      id: `codex:plugin:${pluginId}`,
      toolId: TOOL_ID,
      kind: "plugin",
      displayName: pluginId,
      source: pluginId,
      installed: meta.enabled !== false
    });
  }

  for (const skill of skills) {
    if (!skill.path) continue;
    const name = path.basename(skill.path.replace(/\/$/, ""));
    discovered.push({
      id: `codex:skill:${name}`,
      toolId: TOOL_ID,
      kind: "skill",
      displayName: name,
      source: skill.path,
      installed: skill.enabled !== false
    });
  }

  const skillDirs = [
    path.join(roots.homeDir, ".codex", "skills"),
    path.join(roots.homeDir, "codex", "skills"),
    ...(roots.projectDir ? [path.join(roots.projectDir, ".codex", "skills")] : [])
  ];
  for (const dir of skillDirs) {
    const prefix = dir.includes(roots.homeDir) ? "codex:user:" : "codex:project:";
    discovered.push(...(await discoverCodexSkillsFromDir(dir, prefix)));
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
